import { PublicKey } from "@solana/web3.js";
import { CCTP_DOMAINS, type BridgeTransfer } from "@noirwire/shared";
import { bytesToHex, type Hex } from "viem";
import { forwarderDelivery, type AdapterContext, type DeliverResult, type RouteAdapter } from "./executor.ts";
import type { StepLog } from "./vault.ts";
import type { EvmDriver } from "./evm.ts";
import { encodeForwardHookData, encodeVaultHookData, HYPERCORE_DEX } from "./hooks.ts";
import { matchesCredit, type HyperCoreLedger, type HyperCoreReader, type LedgerMatchConfig } from "./hyperliquid.ts";
import type { Attester } from "./iris.ts";
import { addressToBytes32, decodeBurnBody, decodeMessage, FINALITY_FAST, ZERO_BYTES32 } from "./message.ts";
import type { SolanaDriver } from "./solana.ts";

function armMessageAccount(journal: StepLog, transfer: BridgeTransfer): (messageAccount: PublicKey) => void {
  return (messageAccount) => journal.write({ status: "armed", amount: transfer.grossAmount, messageAccount: messageAccount.toBase58() }, true);
}

async function solanaBalanceConcern(solana: SolanaDriver, transfer: BridgeTransfer): Promise<string | undefined> {
  const balance = await solana.usdcBalance();
  const amount = BigInt(transfer.grossAmount);
  return balance < amount ? `the bridge Solana account holds ${balance} base units, less than the ${amount} to burn` : undefined;
}

function burnMessage(evm: EvmDriver, transfer: BridgeTransfer): Promise<Hex | undefined> {
  return evm.messageFromBurn(transfer.burnTx as Hex);
}

export type HypercoreForwardOptions = {
  forwarder: Hex;
  recipient: Hex;
  reader: HyperCoreReader;
  ledger: HyperCoreLedger;
  match: LedgerMatchConfig;
};

abstract class HypercoreForwardAdapter implements RouteAdapter {
  constructor(
    protected readonly iris: Attester,
    protected readonly options: HypercoreForwardOptions,
  ) {}

  abstract burn(transfer: BridgeTransfer, context: AdapterContext): Promise<{ burnTx: string }>;
  abstract messageFor(transfer: BridgeTransfer): Promise<Hex | undefined>;

  async creditedInLedger(_transfer: BridgeTransfer, expected: bigint, since: number): Promise<boolean> {
    const entries = await this.options.ledger.entries(this.options.recipient, since);
    return entries.some((entry) => matchesCredit(entry, this.options.match, this.options.recipient, expected, since));
  }

  async deliver(transfer: BridgeTransfer): Promise<DeliverResult> {
    const result = await this.iris.fetchAttestation({
      sourceDomain: transfer.sourceDomain,
      txHash: transfer.burnTx as string,
    });
    return forwarderDelivery(result.forward, "forwarded");
  }

  destinationBalance(): Promise<bigint> {
    return this.options.reader.balance(this.options.recipient);
  }

  protected burnParams(transfer: BridgeTransfer) {
    const forwarder = addressToBytes32(this.options.forwarder);
    return {
      amount: BigInt(transfer.grossAmount),
      destinationDomain: CCTP_DOMAINS.hyperEvm,
      mintRecipient: forwarder,
      destinationCaller: forwarder,
      maxFee: BigInt(transfer.maxFee),
      minFinalityThreshold: FINALITY_FAST,
      hookData: encodeForwardHookData(this.options.recipient, HYPERCORE_DEX.perps),
    };
  }
}

export class SolanaHypercoreAdapter extends HypercoreForwardAdapter {
  constructor(
    private readonly solana: SolanaDriver,
    iris: Attester,
    options: HypercoreForwardOptions,
  ) {
    super(iris, options);
  }

  preflight(transfer: BridgeTransfer): Promise<string | undefined> {
    return solanaBalanceConcern(this.solana, transfer);
  }

  async burn(transfer: BridgeTransfer, { journal }: AdapterContext): Promise<{ burnTx: string }> {
    const { signature } = await this.solana.burn(
      { transferId: transfer.transferId, ...this.burnParams(transfer) },
      armMessageAccount(journal, transfer),
    );
    return { burnTx: signature };
  }

  async messageFor(): Promise<Hex | undefined> {
    return undefined;
  }
}

export class ArcHypercoreAdapter extends HypercoreForwardAdapter {
  constructor(
    private readonly evm: EvmDriver,
    iris: Attester,
    options: HypercoreForwardOptions,
  ) {
    super(iris, options);
  }

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const burnTx = await this.evm.depositForBurn(this.burnParams(transfer));
    return { burnTx };
  }

  messageFor(transfer: BridgeTransfer): Promise<Hex | undefined> {
    return burnMessage(this.evm, transfer);
  }
}

export class ArcSolanaAdapter implements RouteAdapter {
  constructor(
    private readonly evm: EvmDriver,
    private readonly solana: SolanaDriver,
    private readonly options: { makerTokenAccount: PublicKey },
  ) {}

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const burnTx = await this.evm.depositForBurn({
      amount: BigInt(transfer.grossAmount),
      destinationDomain: CCTP_DOMAINS.solana,
      mintRecipient: bytesToHex(this.options.makerTokenAccount.toBytes()),
      destinationCaller: ZERO_BYTES32,
      maxFee: BigInt(transfer.maxFee),
      minFinalityThreshold: FINALITY_FAST,
    });
    return { burnTx };
  }

  messageFor(transfer: BridgeTransfer): Promise<Hex | undefined> {
    return burnMessage(this.evm, transfer);
  }

  async deliver(_transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
    const body = decodeBurnBody(decodeMessage(message).body);
    const tx = await this.solana.receive({ message, attestation, remoteToken: body.burnToken });
    return { status: "done", state: "minted", tx };
  }
}

export class SolanaArcAdapter implements RouteAdapter {
  constructor(
    private readonly solana: SolanaDriver,
    private readonly evm: EvmDriver,
    private readonly options: { hookExecutor: Hex; beneficiary: Hex; solanaDepositor: Hex; deadlineSeconds: number },
  ) {}

  preflight(transfer: BridgeTransfer): Promise<string | undefined> {
    return solanaBalanceConcern(this.solana, transfer);
  }

  async burn(transfer: BridgeTransfer, { journal }: AdapterContext): Promise<{ burnTx: string }> {
    const executor = addressToBytes32(this.options.hookExecutor);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.options.deadlineSeconds);
    const { signature } = await this.solana.burn(
      {
        transferId: transfer.transferId,
        amount: BigInt(transfer.grossAmount),
        destinationDomain: CCTP_DOMAINS.arc,
        mintRecipient: executor,
        destinationCaller: executor,
        maxFee: BigInt(transfer.maxFee),
        minFinalityThreshold: FINALITY_FAST,
        hookData: encodeVaultHookData({
          beneficiary: this.options.beneficiary,
          solanaDepositor: this.options.solanaDepositor,
          deadline,
        }),
      },
      armMessageAccount(journal, transfer),
    );
    return { burnTx: signature };
  }

  async messageFor(): Promise<Hex | undefined> {
    return undefined;
  }

  async deliver(transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
    const tx = await this.evm.relayThroughHookExecutor(message, attestation);
    return { status: "done", state: "hook-executed", tx };
  }

  hookOutcome(transfer: BridgeTransfer): Promise<"vault-credited" | "claimable"> {
    return this.evm.creditedHookOutcome(transfer.mintTx as Hex);
  }
}
