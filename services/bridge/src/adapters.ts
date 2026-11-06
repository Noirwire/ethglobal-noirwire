import { PublicKey } from "@solana/web3.js";
import { CCTP_DOMAINS, type BridgeTransfer } from "@noirwire/shared";
import { bytesToHex, type Hex } from "viem";
import type { DeliverResult, RouteAdapter } from "./executor.ts";
import type { EvmDriver } from "./evm.ts";
import { encodeForwardHookData, encodeVaultHookData, HYPERCORE_DEX } from "./hooks.ts";
import type { HyperCoreReader } from "./hyperliquid.ts";
import type { Attester } from "./iris.ts";
import { addressToBytes32, decodeBurnBody, decodeMessage, FINALITY_FAST, ZERO_BYTES32 } from "./message.ts";
import type { SolanaDriver } from "./solana.ts";

export class ArcHypercoreAdapter implements RouteAdapter {
  constructor(
    private readonly evm: EvmDriver,
    private readonly iris: Attester,
    private readonly options: {
      forwarder: Hex;
      recipient: Hex;
      reader: HyperCoreReader;
    },
  ) {}

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const forwarder = addressToBytes32(this.options.forwarder);
    const burnTx = await this.evm.depositForBurn({
      amount: BigInt(transfer.grossAmount),
      destinationDomain: CCTP_DOMAINS.hyperEvm,
      mintRecipient: forwarder,
      destinationCaller: forwarder,
      maxFee: BigInt(transfer.maxFee),
      minFinalityThreshold: FINALITY_FAST,
      hookData: encodeForwardHookData(this.options.recipient, HYPERCORE_DEX.perps),
    });
    return { burnTx };
  }

  messageFor(transfer: BridgeTransfer): Promise<Hex | undefined> {
    return this.evm.messageFromBurn(transfer.burnTx as Hex);
  }

  async deliver(transfer: BridgeTransfer): Promise<DeliverResult> {
    const result = await this.iris.fetchAttestation({
      sourceDomain: transfer.sourceDomain,
      txHash: transfer.burnTx as string,
    });
    if (result.forward?.state === "COMPLETE") {
      return { status: "done", state: "forwarded", tx: result.forward.mintTxHash };
    }
    if (result.forward?.state === "FAILED") return { status: "pending", reason: "Circle forwarder reported a failure" };
    return { status: "pending", reason: "waiting for the Circle forwarder" };
  }

  destinationBalance(): Promise<bigint> {
    return this.options.reader.balance(this.options.recipient);
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
    return this.evm.messageFromBurn(transfer.burnTx as Hex);
  }

  async deliver(transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
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

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const executor = addressToBytes32(this.options.hookExecutor);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.options.deadlineSeconds);
    const { signature } = await this.solana.burn({
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
    });
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
