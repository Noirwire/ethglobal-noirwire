import type { Hex } from "viem";
import type { StepRecord } from "../src/transfers.ts";
import { VaultRevert, type StepLog, type VaultCall, type VaultChain } from "../src/vault.ts";

export class Crash extends Error {}

export class FakeVaultChain implements VaultChain {
  block = 100n;
  ledger: bigint;
  surplus = 0n;
  treasuryBalance = 0n;
  perCall = 1_000_000_000n;
  epochRoom = 1_000_000_000n;
  pendingTransactions = false;
  crashBeforeSend = false;
  crashAfterSend = false;
  hideReceipts = false;
  sends = 0;
  simulations = 0;
  readonly executed: { hash: Hex; call: VaultCall; block: bigint }[] = [];
  readonly events: string[] = [];

  constructor(ledger: bigint) {
    this.ledger = ledger;
  }

  async head(): Promise<bigint> {
    return this.block;
  }

  async simulate(call: VaultCall): Promise<void> {
    this.simulations++;
    if (call.fn === "moveToVenue") {
      if (call.amount > this.perCall) throw new VaultRevert(`over the per-call move cap of ${this.perCall} base units`);
      if (call.amount > this.epochRoom) throw new VaultRevert(`over the per-epoch move cap, ${this.epochRoom} base units left`);
      if (call.amount > this.ledger) throw new VaultRevert(`the vault has only ${this.ledger} idle base units`);
    } else if (call.amount > this.surplus) {
      throw new VaultRevert("the vault does not hold the returned USDC beyond its ledger yet");
    }
  }

  async send(call: VaultCall): Promise<Hex> {
    if (this.crashBeforeSend) throw new Crash("died before the transaction left");
    this.sends++;
    this.events.push("send");
    this.block++;
    if (call.fn === "moveToVenue") {
      this.ledger -= call.amount;
      this.epochRoom -= call.amount;
      this.treasuryBalance += call.amount;
    } else {
      this.surplus -= call.amount;
      this.ledger += call.amount;
    }
    const hash = `0x${this.sends.toString(16).padStart(64, "0")}` as Hex;
    this.executed.push({ hash, call, block: this.block });
    if (this.crashAfterSend) throw new Crash("died after the transaction left");
    return hash;
  }

  async receipt(hash: Hex): Promise<"success" | "reverted" | undefined> {
    if (this.hideReceipts) return undefined;
    return this.executed.some((entry) => entry.hash === hash) ? "success" : undefined;
  }

  async hasPendingTransactions(): Promise<boolean> {
    return this.pendingTransactions;
  }

  async findExecuted(call: VaultCall, fromBlock: bigint): Promise<Hex[]> {
    return this.executed
      .filter((entry) => entry.call.fn === call.fn && entry.call.amount === call.amount && entry.block >= fromBlock)
      .map((entry) => entry.hash);
  }
}

export class MemoryStepLog implements StepLog {
  record: StepRecord | undefined;
  readonly writes: { status: string; durable: boolean }[] = [];

  constructor(private readonly chain?: FakeVaultChain) {}

  read(): StepRecord | undefined {
    return this.record;
  }

  write(record: StepRecord, durable: boolean): void {
    this.record = record;
    this.writes.push({ status: record.status, durable });
    this.chain?.events.push(`write:${record.status}`);
  }
}
