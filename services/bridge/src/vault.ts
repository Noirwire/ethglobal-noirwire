import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  parseAbi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { StepRecord } from "./transfers.ts";

export const shareVaultAbi = parseAbi([
  "function moveToVenue(address to, uint256 amount)",
  "function acknowledgeReturn(uint256 amount)",
  "event MovedToVenue(address indexed to, uint256 amount)",
  "event ReturnAcknowledged(uint256 amount)",
  "error ShareVault__NotOperator()",
  "error ShareVault__ZeroAmount()",
  "error ShareVault__DestinationNotAllowed()",
  "error ShareVault__OverPerCallCap(uint256 cap)",
  "error ShareVault__OverPerEpochCap(uint256 remaining)",
  "error ShareVault__InsufficientIdleAssets(uint256 available)",
  "error ShareVault__ReturnNotBacked()",
]);

export type StepLog = {
  read(): StepRecord | undefined;
  write(record: StepRecord, durable: boolean): void;
};

export type StepOutcome =
  | { status: "done"; txHash: string }
  | { status: "refused"; reason: string }
  | { status: "pending"; reason: string };

export interface VaultPort {
  readonly vault: string;
  readonly treasury: string;
  release(log: StepLog, amount: bigint, claimed: ReadonlySet<string>): Promise<StepOutcome>;
  acknowledge(log: StepLog, amount: bigint, claimed: ReadonlySet<string>): Promise<StepOutcome>;
}

export type VaultCall =
  | { fn: "moveToVenue"; to: Hex; amount: bigint }
  | { fn: "acknowledgeReturn"; amount: bigint };

export class VaultRevert extends Error {}

export interface VaultChain {
  head(): Promise<bigint>;
  simulate(call: VaultCall): Promise<void>;
  send(call: VaultCall): Promise<Hex>;
  receipt(hash: Hex): Promise<"success" | "reverted" | undefined>;
  hasPendingTransactions(): Promise<boolean>;
  findExecuted(call: VaultCall, fromBlock: bigint): Promise<Hex[]>;
}

type RevertPolicy = "refuse" | "wait";

export class VaultTreasury implements VaultPort {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly vault: string,
    readonly treasury: string,
    private readonly chain: VaultChain,
  ) {}

  release(log: StepLog, amount: bigint, claimed: ReadonlySet<string>): Promise<StepOutcome> {
    return this.exclusive(() => this.once(log, { fn: "moveToVenue", to: this.treasury as Hex, amount }, claimed, "refuse"));
  }

  acknowledge(log: StepLog, amount: bigint, claimed: ReadonlySet<string>): Promise<StepOutcome> {
    return this.exclusive(() => this.once(log, { fn: "acknowledgeReturn", amount }, claimed, "wait"));
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async once(log: StepLog, call: VaultCall, claimed: ReadonlySet<string>, onRevert: RevertPolicy): Promise<StepOutcome> {
    let record = log.read();
    if (record?.status === "done") return { status: "done", txHash: record.txHash as string };
    if (record?.status === "refused") return { status: "refused", reason: record.reason ?? "refused" };

    const amount = call.amount.toString();
    let freshlyArmed = false;
    if (!record) {
      const blocked = await this.revertReason(call);
      if (blocked) return this.blocked(log, amount, blocked, onRevert);
      record = { status: "armed", amount, fromBlock: (await this.chain.head()).toString() };
      log.write(record, true);
      freshlyArmed = true;
    }

    if (record.status === "armed") {
      if (!freshlyArmed) {
        const recovered = await this.recover(call, record, claimed);
        if ("pending" in recovered) return { status: "pending", reason: recovered.pending };
        if (recovered.txHash) {
          record = this.markSent(log, record, recovered.txHash);
        } else {
          const blocked = await this.revertReason(call);
          if (blocked) return this.blocked(log, amount, blocked, onRevert);
        }
      }
      if (record.status === "armed") {
        const txHash = await this.chain.send(call);
        record = this.markSent(log, record, txHash);
      }
    }

    const outcome = await this.chain.receipt(record.txHash as Hex);
    if (outcome === undefined) return { status: "pending", reason: `waiting for ${record.txHash} to be mined` };
    if (outcome === "reverted") {
      const reason = `transaction ${record.txHash} reverted`;
      if (onRevert === "refuse") {
        log.write({ status: "refused", amount, txHash: record.txHash, reason }, true);
        return { status: "refused", reason };
      }
      log.write({ status: "armed", amount, fromBlock: (await this.chain.head()).toString() }, true);
      return { status: "pending", reason };
    }
    log.write({ ...record, status: "done" }, true);
    return { status: "done", txHash: record.txHash as string };
  }

  private markSent(log: StepLog, record: StepRecord, txHash: Hex): StepRecord {
    const sent = { ...record, status: "sent" as const, txHash };
    log.write(sent, true);
    return sent;
  }

  private blocked(log: StepLog, amount: string, reason: string, onRevert: RevertPolicy): StepOutcome {
    if (onRevert === "wait") return { status: "pending", reason };
    log.write({ status: "refused", amount, reason }, true);
    return { status: "refused", reason };
  }

  private async recover(
    call: VaultCall,
    record: StepRecord,
    claimed: ReadonlySet<string>,
  ): Promise<{ txHash?: Hex } | { pending: string }> {
    if (await this.chain.hasPendingTransactions()) {
      return { pending: "operator transactions are still pending, not repeating the vault call yet" };
    }
    const executed = await this.chain.findExecuted(call, BigInt(record.fromBlock ?? "0"));
    const own = executed.find((hash) => !claimed.has(hash.toLowerCase()));
    return own ? { txHash: own } : {};
  }

  private async revertReason(call: VaultCall): Promise<string | undefined> {
    try {
      await this.chain.simulate(call);
      return undefined;
    } catch (error) {
      if (error instanceof VaultRevert) return error.message;
      throw error;
    }
  }
}

function describeRevert(name: string | undefined, args: readonly unknown[] | undefined): string | undefined {
  const first = args?.[0];
  switch (name) {
    case "ShareVault__OverPerCallCap":
      return `over the per-call move cap of ${first} base units`;
    case "ShareVault__OverPerEpochCap":
      return `over the per-epoch move cap, ${first} base units left`;
    case "ShareVault__InsufficientIdleAssets":
      return `the vault has only ${first} idle base units`;
    case "ShareVault__DestinationNotAllowed":
      return "the bridge treasury address is not on the vault allowlist";
    case "ShareVault__NotOperator":
      return "the bridge key is not the vault operator";
    case "ShareVault__ReturnNotBacked":
      return "the vault does not hold the returned USDC beyond its ledger yet";
    default:
      return name;
  }
}

export class ViemVaultChain implements VaultChain {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient<Transport, Chain, Account>,
    private readonly vault: Hex,
  ) {}

  head(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async simulate(call: VaultCall): Promise<void> {
    const account = this.walletClient.account;
    try {
      if (call.fn === "moveToVenue") {
        await this.publicClient.simulateContract({
          account,
          address: this.vault,
          abi: shareVaultAbi,
          functionName: "moveToVenue",
          args: [call.to, call.amount],
        });
      } else {
        await this.publicClient.simulateContract({
          account,
          address: this.vault,
          abi: shareVaultAbi,
          functionName: "acknowledgeReturn",
          args: [call.amount],
        });
      }
    } catch (error) {
      if (error instanceof BaseError) {
        const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
        if (reverted instanceof ContractFunctionRevertedError) {
          const reason = describeRevert(reverted.data?.errorName, reverted.data?.args) ?? reverted.shortMessage;
          throw new VaultRevert(reason);
        }
      }
      throw error;
    }
  }

  send(call: VaultCall): Promise<Hex> {
    if (call.fn === "moveToVenue") {
      return this.walletClient.writeContract({
        address: this.vault,
        abi: shareVaultAbi,
        functionName: "moveToVenue",
        args: [call.to, call.amount],
      });
    }
    return this.walletClient.writeContract({
      address: this.vault,
      abi: shareVaultAbi,
      functionName: "acknowledgeReturn",
      args: [call.amount],
    });
  }

  async receipt(hash: Hex): Promise<"success" | "reverted" | undefined> {
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return receipt.status === "success" ? "success" : "reverted";
    } catch (error) {
      if (
        error instanceof WaitForTransactionReceiptTimeoutError ||
        error instanceof TransactionReceiptNotFoundError ||
        error instanceof TransactionNotFoundError
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async hasPendingTransactions(): Promise<boolean> {
    const address = this.walletClient.account.address;
    const [latest, pending] = await Promise.all([
      this.publicClient.getTransactionCount({ address, blockTag: "latest" }),
      this.publicClient.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    return pending > latest;
  }

  async findExecuted(call: VaultCall, fromBlock: bigint): Promise<Hex[]> {
    if (call.fn === "moveToVenue") {
      const logs = await this.publicClient.getLogs({
        address: this.vault,
        event: shareVaultAbi[2],
        args: { to: call.to },
        fromBlock,
        toBlock: "latest",
      });
      return logs.filter((log) => log.args.amount === call.amount && log.transactionHash).map((log) => log.transactionHash as Hex);
    }
    const logs = await this.publicClient.getLogs({
      address: this.vault,
      event: shareVaultAbi[3],
      fromBlock,
      toBlock: "latest",
    });
    return logs.filter((log) => log.args.amount === call.amount && log.transactionHash).map((log) => log.transactionHash as Hex);
  }
}
