import { describe, expect, it } from "vitest";
import { VaultTreasury } from "../src/vault.ts";
import { Crash, FakeVaultChain, MemoryStepLog } from "./fake-vault.ts";

const TREASURY = "0x00000000000000000000000000000000000000aa";
const VAULT = "0x00000000000000000000000000000000000000bb";
const NONE: ReadonlySet<string> = new Set();

function setup(ledger = 1_000_000_000n) {
  const chain = new FakeVaultChain(ledger);
  const log = new MemoryStepLog(chain);
  return { chain, log, treasury: () => new VaultTreasury(VAULT, TREASURY, chain) };
}

describe("release from the vault", () => {
  it("journals the armed record durably before the transaction is sent", async () => {
    const { chain, log, treasury } = setup();
    const outcome = await treasury().release(log, 400_000_000n, NONE);
    expect(outcome.status).toBe("done");
    expect(chain.events).toEqual(["write:armed", "send", "write:sent", "write:done"]);
    expect(log.writes.every((entry) => entry.durable)).toBe(true);
    expect(chain.ledger).toBe(600_000_000n);
    expect(chain.treasuryBalance).toBe(400_000_000n);
  });

  it("moves once when the process dies between the journal and the transaction", async () => {
    const { chain, log, treasury } = setup();
    chain.crashBeforeSend = true;
    await expect(treasury().release(log, 400_000_000n, NONE)).rejects.toBeInstanceOf(Crash);
    expect(log.record?.status).toBe("armed");
    expect(chain.sends).toBe(0);

    chain.crashBeforeSend = false;
    const outcome = await treasury().release(log, 400_000_000n, NONE);
    expect(outcome.status).toBe("done");
    expect(chain.sends).toBe(1);
    expect(chain.treasuryBalance).toBe(400_000_000n);
  });

  it("adopts the onchain move when the process dies after the transaction left", async () => {
    const { chain, log, treasury } = setup();
    chain.crashAfterSend = true;
    await expect(treasury().release(log, 400_000_000n, NONE)).rejects.toBeInstanceOf(Crash);
    expect(log.record).toMatchObject({ status: "armed" });
    expect(log.record?.txHash).toBeUndefined();
    expect(chain.treasuryBalance).toBe(400_000_000n);

    chain.crashAfterSend = false;
    const outcome = await treasury().release(log, 400_000_000n, NONE);
    expect(outcome).toEqual({ status: "done", txHash: chain.executed[0]?.hash });
    expect(chain.sends).toBe(1);
    expect(chain.ledger).toBe(600_000_000n);
  });

  it("does not repeat the call while the operator still has pending transactions", async () => {
    const { chain, log, treasury } = setup();
    chain.crashAfterSend = true;
    await expect(treasury().release(log, 400_000_000n, NONE)).rejects.toBeInstanceOf(Crash);
    chain.crashAfterSend = false;
    chain.pendingTransactions = true;
    const outcome = await treasury().release(log, 400_000_000n, NONE);
    expect(outcome.status).toBe("pending");
    expect(chain.sends).toBe(1);
  });

  it("resumes from the journaled hash after a crash once the tx is journaled", async () => {
    const { chain, log, treasury } = setup();
    chain.hideReceipts = true;
    const first = await treasury().release(log, 400_000_000n, NONE);
    expect(first.status).toBe("pending");
    expect(log.record?.status).toBe("sent");

    chain.hideReceipts = false;
    const second = await treasury().release(log, 400_000_000n, NONE);
    expect(second.status).toBe("done");
    expect(chain.sends).toBe(1);
  });

  it("does not adopt a move that belongs to another transfer", async () => {
    const { chain, log, treasury } = setup();
    const otherLog = new MemoryStepLog(chain);
    await treasury().release(otherLog, 400_000_000n, NONE);
    const claimed = new Set([otherLog.record?.txHash?.toLowerCase() as string]);

    chain.crashBeforeSend = true;
    await expect(treasury().release(log, 400_000_000n, claimed)).rejects.toBeInstanceOf(Crash);
    chain.crashBeforeSend = false;
    await treasury().release(log, 400_000_000n, claimed);
    expect(chain.sends).toBe(2);
    expect(chain.treasuryBalance).toBe(800_000_000n);
  });

  it.each([
    ["the per-call cap", (chain: FakeVaultChain) => (chain.perCall = 100n), /per-call move cap/],
    ["the per-epoch cap", (chain: FakeVaultChain) => (chain.epochRoom = 100n), /per-epoch move cap/],
    ["an idle asset shortfall", (chain: FakeVaultChain) => (chain.ledger = 100n), /idle base units/],
  ])("refuses with the reason when the vault would revert on %s, and never retries", async (_name, arrange, reason) => {
    const { chain, log, treasury } = setup();
    arrange(chain);
    const outcome = await treasury().release(log, 400_000_000n, NONE);
    expect(outcome).toMatchObject({ status: "refused" });
    expect(outcome.status === "refused" && outcome.reason).toMatch(reason);
    expect(chain.sends).toBe(0);

    const simulations = chain.simulations;
    const again = await treasury().release(log, 400_000_000n, NONE);
    expect(again.status).toBe("refused");
    expect(chain.simulations).toBe(simulations);
    expect(chain.sends).toBe(0);
  });
});

describe("acknowledging a return", () => {
  it("acknowledges once however many times it is asked", async () => {
    const { chain, log, treasury } = setup(0n);
    chain.surplus = 250_000_000n;
    const first = await treasury().acknowledge(log, 250_000_000n, NONE);
    const second = await treasury().acknowledge(log, 250_000_000n, NONE);
    expect(first.status).toBe("done");
    expect(second).toEqual(first);
    expect(chain.sends).toBe(1);
    expect(chain.ledger).toBe(250_000_000n);
    expect(chain.surplus).toBe(0n);
  });

  it("adopts the acknowledgement when the process dies after the transaction left", async () => {
    const { chain, log, treasury } = setup(0n);
    chain.surplus = 250_000_000n;
    chain.crashAfterSend = true;
    await expect(treasury().acknowledge(log, 250_000_000n, NONE)).rejects.toBeInstanceOf(Crash);
    chain.crashAfterSend = false;
    const outcome = await treasury().acknowledge(log, 250_000_000n, NONE);
    expect(outcome.status).toBe("done");
    expect(chain.sends).toBe(1);
    expect(chain.ledger).toBe(250_000_000n);
  });

  it("acknowledges once when the process dies before the transaction", async () => {
    const { chain, log, treasury } = setup(0n);
    chain.surplus = 250_000_000n;
    chain.crashBeforeSend = true;
    await expect(treasury().acknowledge(log, 250_000_000n, NONE)).rejects.toBeInstanceOf(Crash);
    chain.crashBeforeSend = false;
    await treasury().acknowledge(log, 250_000_000n, NONE);
    await treasury().acknowledge(log, 250_000_000n, NONE);
    expect(chain.sends).toBe(1);
  });

  it("waits, without recording a refusal, while the vault does not yet hold the USDC", async () => {
    const { chain, log, treasury } = setup(0n);
    const outcome = await treasury().acknowledge(log, 250_000_000n, NONE);
    expect(outcome.status).toBe("pending");
    expect(log.record).toBeUndefined();

    chain.surplus = 250_000_000n;
    expect((await treasury().acknowledge(log, 250_000_000n, NONE)).status).toBe("done");
  });
});
