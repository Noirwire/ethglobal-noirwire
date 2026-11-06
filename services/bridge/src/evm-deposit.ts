import { CCTP_DOMAINS, CHAIN_CCTP_DOMAIN, ROUTE_ENDPOINTS, type BridgeTransfer, type TransferRoute } from "@noirwire/shared";
import { createPublicClient, http, parseEventLogs, size, zeroAddress, type Hex, type PublicClient } from "viem";
import { BurnRefused, DEPOSITOR_BURN_ROUTES, type AdapterContext, type DeliverResult, type RouteAdapter, type TreasuryExecutor } from "./executor.ts";
import { messageTransmitterV2Abi, type EvmDriver } from "./evm.ts";
import { decodeVaultHookData, VAULT_HOOK_VERSION } from "./hooks.ts";
import { addressToBytes32, BURN_BODY_VERSION, decodeBurnBody, decodeMessage, MESSAGE_VERSION } from "./message.ts";
import { DepositRefused, DepositUnavailable, TransactionNotFound } from "./solana-deposit.ts";
import type { TransferStore } from "./transfers.ts";

const HOOK_DATA_BYTES = 128;

export const EVM_DEPOSIT_ROUTES: Readonly<Record<number, TransferRoute>> = Object.fromEntries(
  [...DEPOSITOR_BURN_ROUTES].map((route) => [CHAIN_CCTP_DOMAIN[ROUTE_ENDPOINTS[route].from], route]),
);

export type EvmDepositSource = {
  label: string;
  tokenMessenger: Hex;
  usdc: Hex;
};

export type ObservedBurn = { failed: boolean; messages: Hex[] };

export interface EvmSourceReader {
  burnTransaction(domain: number, txHash: Hex): Promise<ObservedBurn | null>;
}

export class ViemSourceReader implements EvmSourceReader {
  private readonly clients = new Map<number, PublicClient>();

  constructor(
    private readonly rpcUrls: Readonly<Record<number, string>>,
    private readonly transmitters: Readonly<Record<number, Hex>>,
  ) {}

  private client(domain: number): PublicClient {
    const existing = this.clients.get(domain);
    if (existing) return existing;
    const url = this.rpcUrls[domain];
    if (!url) throw new DepositRefused(`no RPC is configured for source domain ${domain}`);
    const created = createPublicClient({ transport: http(url) });
    this.clients.set(domain, created);
    return created;
  }

  async burnTransaction(domain: number, txHash: Hex): Promise<ObservedBurn | null> {
    const transmitter = this.transmitters[domain];
    if (!transmitter) throw new DepositRefused(`source domain ${domain} is not supported`);
    let receipt;
    try {
      receipt = await this.client(domain).getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
    const sent = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: "MessageSent", logs: receipt.logs });
    return {
      failed: receipt.status !== "success",
      messages: sent.filter((log) => log.address.toLowerCase() === transmitter.toLowerCase()).map((log) => log.args.message),
    };
  }
}

type EvmDepositStatus = { available: boolean; reason?: string };

export interface EvmDepositApi {
  status(): EvmDepositStatus;
  register(domain: number, txHash: string): Promise<BridgeTransfer>;
}

export class UnavailableEvmDeposits implements EvmDepositApi {
  constructor(private readonly reason: string) {}

  status(): EvmDepositStatus {
    return { available: false, reason: this.reason };
  }

  async register(): Promise<BridgeTransfer> {
    throw new DepositUnavailable(this.reason);
  }
}

export class EvmArcAdapter implements RouteAdapter {
  constructor(private readonly evm: EvmDriver) {}

  async burn(_transfer: BridgeTransfer, _context: AdapterContext): Promise<{ burnTx: string }> {
    throw new BurnRefused("the depositor burns on the source chain, the bridge never burns on this route");
  }

  async messageFor(): Promise<Hex | undefined> {
    return undefined;
  }

  async deliver(_transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
    const tx = await this.evm.relayThroughHookExecutor(message, attestation);
    return { status: "done", state: "hook-executed", tx };
  }

  hookOutcome(transfer: BridgeTransfer): Promise<"vault-credited" | "claimable"> {
    return this.evm.creditedHookOutcome(transfer.mintTx as Hex);
  }
}

type EvmDepositOptions = {
  hookExecutor: Hex;
  localTokenMessenger: Hex;
  sources: Readonly<Record<number, EvmDepositSource>>;
};

type VerifiedBurn = { amount: bigint; maxFee: bigint; beneficiary: Hex };

export class EvmDeposits implements EvmDepositApi {
  constructor(
    private readonly reader: EvmSourceReader,
    private readonly executor: TreasuryExecutor,
    private readonly store: TransferStore,
    private readonly options: EvmDepositOptions,
  ) {}

  status(): EvmDepositStatus {
    return { available: true };
  }

  async register(domain: number, txHash: string): Promise<BridgeTransfer> {
    const route = EVM_DEPOSIT_ROUTES[domain];
    const source = this.options.sources[domain];
    if (!route || !source) throw new DepositRefused(`source domain ${domain} is not supported`);
    const burnTx = txHash.toLowerCase() as Hex;

    const known = this.store.get(`${burnTx}:0`);
    if (known) {
      void this.executor.advance(known.transferId);
      return known;
    }

    const observed = await this.reader.burnTransaction(domain, burnTx);
    if (!observed) throw new TransactionNotFound(`The transaction is not visible on ${source.label} yet. Try again in a few seconds.`);
    if (observed.failed) throw new DepositRefused(`The transaction failed on ${source.label}, nothing was burned.`);

    for (const message of observed.messages) {
      const burn = this.verify(domain, source, message);
      if (!burn) continue;
      return this.executor.adoptAndAdvance({ route, burnTx, amount: burn.amount, beneficiary: burn.beneficiary, maxFee: burn.maxFee });
    }
    throw new DepositRefused("This transaction is not a deposit into the NoirWire vault, so the bridge will not relay it.");
  }

  private verify(domain: number, source: EvmDepositSource, message: Hex): VerifiedBurn | undefined {
    const executorWord = addressToBytes32(this.options.hookExecutor);
    try {
      const header = decodeMessage(message);
      const body = decodeBurnBody(header.body);
      const routed =
        header.version === MESSAGE_VERSION &&
        body.version === BURN_BODY_VERSION &&
        header.sourceDomain === domain &&
        header.destinationDomain === CCTP_DOMAINS.arc &&
        header.sender === addressToBytes32(source.tokenMessenger) &&
        header.recipient === addressToBytes32(this.options.localTokenMessenger) &&
        header.destinationCaller === executorWord &&
        body.mintRecipient === executorWord &&
        body.burnToken === addressToBytes32(source.usdc);
      if (!routed || size(body.hookData) !== HOOK_DATA_BYTES) return undefined;
      const hook = decodeVaultHookData(body.hookData);
      if (hook.version !== VAULT_HOOK_VERSION || hook.beneficiary === zeroAddress || hook.solanaDepositor !== body.messageSender) {
        return undefined;
      }
      return { amount: body.amount, maxFee: body.maxFee, beneficiary: hook.beneficiary };
    } catch {
      return undefined;
    }
  }
}
