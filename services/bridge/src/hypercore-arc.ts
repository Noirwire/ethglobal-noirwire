import { CCTP_DOMAINS, type BridgeTransfer } from "@noirwire/shared";
import type { PublicKey } from "@solana/web3.js";
import { bytesToHex, parseAbiItem, type Hex, type LocalAccount, type PublicClient } from "viem";
import { z } from "zod";
import { BurnRefused, forwarderDelivery, type AdapterContext, type DeliverResult, type RouteAdapter } from "./executor.ts";
import {
  matchesDebit,
  type HyperCoreLedger,
  type LedgerMatchConfig,
} from "./hyperliquid.ts";
import {
  usdcAmountString,
  signSendToEvmWithData,
  HYPERLIQUID_TOKEN,
  type HyperliquidExchange,
  type HyperliquidNetwork,
  type SendToEvmWithData,
  type SourceDex,
} from "./hyperliquid-withdraw.ts";
import type { Attester } from "./iris.ts";
import { addressToBytes32, decodeBurnBody, decodeMessage } from "./message.ts";
import type { SolanaDriver } from "./solana.ts";
import type { StepRecord } from "./transfers.ts";
import type { StepLog } from "./vault.ts";

export const LEDGER_CLOCK_SKEW_MS = 60_000;
const HYPEREVM_LOG_RANGE = 1000n;

export const depositForBurnEvent = parseAbiItem(
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
);

export type BurnLog = {
  transactionHash: Hex;
  blockNumber: bigint;
  amount: bigint;
  depositor: Hex;
  destinationDomain: number;
  mintRecipient: Hex;
  hookData: Hex;
};

export interface HyperEvmBurns {
  head(): Promise<bigint>;
  burnsSince(fromBlock: bigint, depositor: Hex): Promise<BurnLog[]>;
}

export class ViemHyperEvmBurns implements HyperEvmBurns {
  constructor(
    private readonly client: PublicClient,
    private readonly tokenMessenger: Hex,
  ) {}

  head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async burnsSince(fromBlock: bigint, depositor: Hex): Promise<BurnLog[]> {
    const head = await this.client.getBlockNumber();
    const found: BurnLog[] = [];
    for (let from = fromBlock; from <= head; from += HYPEREVM_LOG_RANGE) {
      const to = from + HYPEREVM_LOG_RANGE - 1n < head ? from + HYPEREVM_LOG_RANGE - 1n : head;
      const logs = await this.client.getLogs({
        address: this.tokenMessenger,
        event: depositForBurnEvent,
        args: { depositor },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const { amount, mintRecipient, destinationDomain, hookData } = log.args;
        if (amount === undefined || mintRecipient === undefined || destinationDomain === undefined || log.transactionHash === null) continue;
        found.push({
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber ?? 0n,
          amount,
          depositor,
          destinationDomain,
          mintRecipient,
          hookData: hookData ?? "0x",
        });
      }
    }
    return found;
  }
}

export interface ReturnFees {
  forwardingFee(): Promise<bigint>;
}

const feeResponse = z.array(
  z.object({ forwardFee: z.object({ med: z.number().optional(), medium: z.number().optional() }).optional() }),
);

export class IrisReturnFees implements ReturnFees {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async forwardingFee(): Promise<bigint> {
    const url = `${this.baseUrl}/v2/burn/USDC/fees/${CCTP_DOMAINS.hyperEvm}/${CCTP_DOMAINS.arc}?forward=true`;
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Iris fee quote ${response.status} for ${url}`);
    const quotes = feeResponse.parse(await response.json()).flatMap((entry) => {
      const fee = entry.forwardFee?.med ?? entry.forwardFee?.medium;
      return fee === undefined ? [] : [fee];
    });
    if (quotes.length === 0) throw new Error("Iris returned no forwarding fee for HyperEVM to Arc, refusing to guess one");
    return BigInt(Math.ceil(Math.max(...quotes)));
  }
}

export type HypercoreWithdrawOptions = {
  account: LocalAccount;
  coreDepositWallet: Hex;
  hyperliquidChain: HyperliquidNetwork;
  sourceDex: SourceDex;
  gasLimit: number;
  match: LedgerMatchConfig;
  exchange: HyperliquidExchange;
  ledger: HyperCoreLedger;
  burns: HyperEvmBurns;
  iris: Attester;
  now?: () => number;
};

export type HypercoreArcOptions = HypercoreWithdrawOptions & {
  vault: Hex;
  fees: ReturnFees;
  vaultBalance: () => Promise<bigint>;
};

const burnTxOf = (record: StepRecord): string => `hl:${record.nonce}`;

const markSent = (journal: StepLog, record: StepRecord): void => journal.write({ ...record, status: "sent" }, true);

type WithdrawDestination = { recipient: string; encoding: "hex" | "base58"; domain: number };

export abstract class HypercoreWithdrawAdapter<O extends HypercoreWithdrawOptions> implements RouteAdapter {
  readonly idempotentBurn = true;
  private lastNonce = 0;

  constructor(protected readonly options: O) {}

  protected abstract destination(): WithdrawDestination;
  protected abstract checkFee(transfer: BridgeTransfer, amount: bigint): Promise<void>;
  protected abstract burnTargetsDestination(burn: BurnLog): boolean;
  abstract deliver(transfer: BridgeTransfer, message: Hex, attestation: Hex, context: AdapterContext): Promise<DeliverResult>;

  private nextNonce(): number {
    this.lastNonce = Math.max((this.options.now ?? Date.now)(), this.lastNonce + 1);
    return this.lastNonce;
  }

  async burn(transfer: BridgeTransfer, { journal }: AdapterContext): Promise<{ burnTx: string }> {
    const amount = BigInt(transfer.grossAmount);
    let record = journal.read();
    if (record?.status === "refused") throw new BurnRefused(record.reason ?? "the withdrawal was refused");
    if (record && record.status !== "armed") return { burnTx: burnTxOf(record) };

    let fresh = false;
    if (!record) {
      await this.checkFee(transfer, amount);
      record = {
        status: "armed",
        amount: amount.toString(),
        fromBlock: (await this.options.burns.head()).toString(),
        nonce: this.nextNonce().toString(),
      };
      journal.write(record, true);
      fresh = true;
    } else if (await this.debitSeen(record, amount)) {
      markSent(journal, record);
      return { burnTx: burnTxOf(record) };
    }

    const response = await this.options.exchange.post(await signSendToEvmWithData(this.options.account, this.action(record, amount)));
    if (response.status === "err") {
      if (!fresh) throw new Error(`Hyperliquid answered "${response.reason}" to a re-sent withdrawal, the first attempt may have landed`);
      const reason = `Hyperliquid rejected the withdrawal: ${response.reason}`;
      journal.write({ ...record, status: "refused", reason }, true);
      throw new BurnRefused(reason);
    }
    markSent(journal, record);
    return { burnTx: burnTxOf(record) };
  }

  private action(record: StepRecord, amount: bigint): SendToEvmWithData {
    const destination = this.destination();
    return {
      hyperliquidChain: this.options.hyperliquidChain,
      token: HYPERLIQUID_TOKEN,
      amount: usdcAmountString(amount),
      sourceDex: this.options.sourceDex,
      destinationRecipient: destination.recipient,
      addressEncoding: destination.encoding,
      destinationChainId: destination.domain,
      gasLimit: this.options.gasLimit,
      data: "0x",
      nonce: Number(record.nonce),
    };
  }

  private async debitSeen(record: StepRecord, amount: bigint): Promise<boolean> {
    const nonce = Number(record.nonce);
    const since = nonce - LEDGER_CLOCK_SKEW_MS;
    const entries = await this.options.ledger.entries(this.options.account.address, since);
    return entries.some((entry) => matchesDebit(entry, this.options.match, amount, since));
  }

  async attestationTxHash(transfer: BridgeTransfer, { journal }: AdapterContext): Promise<string> {
    const record = journal.read();
    if (!record || record.status === "armed" || record.status === "refused") throw new Error("the withdrawal has not been accepted by Hyperliquid yet");
    if (record.status === "done" && record.txHash) return record.txHash;

    const amount = BigInt(transfer.grossAmount);
    if (!(await this.debitSeen(record, amount))) throw new Error("waiting for the HyperCore ledger to show the debit");

    const tolerance = this.options.match.amountTolerance;
    const burns = await this.options.burns.burnsSince(BigInt(record.fromBlock ?? "0"), this.options.coreDepositWallet);
    const burn = burns.find(
      (candidate) =>
        candidate.destinationDomain === this.destination().domain &&
        (candidate.amount > amount ? candidate.amount - amount : amount - candidate.amount) <= tolerance &&
        this.burnTargetsDestination(candidate),
    );
    if (!burn) throw new Error("waiting for the HyperEVM burn from the CoreDepositWallet");
    journal.write({ ...record, status: "done", txHash: burn.transactionHash }, true);
    return burn.transactionHash;
  }

  async messageFor(): Promise<Hex | undefined> {
    return undefined;
  }
}

export class HypercoreArcAdapter extends HypercoreWithdrawAdapter<HypercoreArcOptions> {
  protected destination(): WithdrawDestination {
    return { recipient: this.options.vault.toLowerCase(), encoding: "hex", domain: CCTP_DOMAINS.arc };
  }

  protected burnTargetsDestination(burn: BurnLog): boolean {
    const vaultHex = this.options.vault.slice(2).toLowerCase();
    return (
      burn.mintRecipient.toLowerCase() === addressToBytes32(this.options.vault).toLowerCase() ||
      burn.hookData.toLowerCase().includes(vaultHex)
    );
  }

  protected async checkFee(transfer: BridgeTransfer, amount: bigint): Promise<void> {
    const fee = await this.options.fees.forwardingFee();
    const ceiling = BigInt(transfer.maxFee);
    if (fee > ceiling) throw new BurnRefused(`the forwarding fee of ${fee} base units is above the ${ceiling} base unit maximum`);
    if (amount <= fee) throw new BurnRefused(`the amount of ${amount} base units does not cover the ${fee} base unit forwarding fee`);
  }

  async deliver(transfer: BridgeTransfer, _message: Hex, _attestation: Hex, { journal }: AdapterContext): Promise<DeliverResult> {
    const txHash = journal.read()?.txHash;
    if (!txHash) return { status: "pending", reason: "the HyperEVM burn has not been located" };
    const result = await this.options.iris.fetchAttestation({ sourceDomain: transfer.sourceDomain, txHash });
    return forwarderDelivery(result.forward, "minted");
  }

  destinationBalance(): Promise<bigint> {
    return this.options.vaultBalance();
  }
}

export type HypercoreSolanaOptions = HypercoreWithdrawOptions & {
  solana: SolanaDriver;
  makerOwner: PublicKey;
};

export class HypercoreSolanaAdapter extends HypercoreWithdrawAdapter<HypercoreSolanaOptions> {
  private makerTokenAccount(): PublicKey {
    return this.options.solana.tokenAccount(this.options.makerOwner);
  }

  protected destination(): WithdrawDestination {
    return { recipient: this.makerTokenAccount().toBase58(), encoding: "base58", domain: CCTP_DOMAINS.solana };
  }

  protected burnTargetsDestination(burn: BurnLog): boolean {
    return burn.mintRecipient.toLowerCase() === bytesToHex(this.makerTokenAccount().toBytes()).toLowerCase();
  }

  protected async checkFee(transfer: BridgeTransfer, amount: bigint): Promise<void> {
    const ceiling = BigInt(transfer.maxFee);
    if (amount <= ceiling) throw new BurnRefused(`the amount of ${amount} base units does not cover the ${ceiling} base unit fee ceiling`);
  }

  async deliver(_transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
    const body = decodeBurnBody(decodeMessage(message).body);
    const tx = await this.options.solana.receive({
      message,
      attestation,
      remoteToken: body.burnToken,
      recipient: this.options.makerOwner,
    });
    return { status: "done", state: "minted", tx };
  }

  destinationBalance(): Promise<bigint> {
    return this.options.solana.usdcBalance(this.options.makerOwner);
  }
}
