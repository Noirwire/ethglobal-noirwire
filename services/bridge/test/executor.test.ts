import type { TopUpIntent } from "@noirwire/shared";
import { describe, expect, it } from "vitest";
import {
  HYPERCORE_MAX_PER_TRANSFER,
  IntentRejected,
  TreasuryExecutor,
  type DeliverResult,
  type ExecutorConfig,
  type RouteAdapter,
} from "../src/executor.ts";
import type { Attestation, Attester } from "../src/iris.ts";
import { TransferStore } from "../src/transfers.ts";
import { buildBurnMessage, clock, tempJournal, word } from "./helpers.ts";

const intentId = (n: number) => word(n);

function intent(overrides: Partial<TopUpIntent> = {}): TopUpIntent {
  return {
    intentId: intentId(1),
    closeId: 1,
    route: "arc-hypercore",
    amount: "500000000",
    reason: "margin-low",
    marginRatioBps: 9000,
    ...overrides,
  };
}

function config(overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    routes: {
      "arc-hypercore": { destination: "0xHyperCore", maxFee: 300_000n },
      "arc-solana": { destination: "MakerTokenAccount", maxFee: 1_000n },
    },
    allowlist: new Set(["0xhypercore", "makertokenaccount"]),
    dailyCap: 5_000_000_000n,
    defaultPerTransferCap: 1_000_000_000n,
    stuckTimeoutMs: 60_000,
    stuckRetryMs: 5_000,
    ...overrides,
  };
}

class FakeAttester implements Attester {
  label = "local-test-attester" as const;
  ready = true;
  calls = 0;
  constructor(private readonly messageFor: (txHash: string) => `0x${string}`) {}
  async fetchAttestation(query: { txHash: string }): Promise<Attestation> {
    this.calls++;
    if (!this.ready) return { status: "pending" };
    return { status: "complete", message: this.messageFor(query.txHash), attestation: "0xabcd" };
  }
}

class FakeAdapter implements RouteAdapter {
  burns = 0;
  balance = 0n;
  deliverResult: DeliverResult = { status: "done", state: "forwarded", tx: "0xmint" };
  failBurn = false;
  constructor(private readonly message: (burnTx: string) => `0x${string}`) {}

  async burn() {
    this.burns++;
    if (this.failBurn) throw new Error("rpc down");
    return { burnTx: `0xburn${this.burns}` };
  }
  async messageFor(transfer: { burnTx?: string }) {
    return this.message(transfer.burnTx as string);
  }
  async deliver() {
    return this.deliverResult;
  }
  async destinationBalance() {
    return this.balance;
  }
}

const hyperMessage = (burnTx: string) =>
  buildBurnMessage({ sourceDomain: 26, destinationDomain: 19, amount: 500_000_000n, feeExecuted: 250_000n, nonce: word(burnTx.length * 1000 + Number(burnTx.slice(-1))) });

function setup(options: { cfg?: Partial<ExecutorConfig>; journal?: string } = {}) {
  const time = clock();
  const store = new TransferStore(options.journal, time.now);
  const attester = new FakeAttester(hyperMessage);
  const adapter = new FakeAdapter(hyperMessage);
  const executor = new TreasuryExecutor(store, attester, { "arc-hypercore": adapter, "arc-solana": adapter }, config(options.cfg), time.now);
  return { time, store, attester, adapter, executor };
}

describe("intent policy", () => {
  it("splits a HyperCore amount over 1000 USDC into capped transfers", () => {
    const { executor } = setup({ cfg: { defaultPerTransferCap: 5_000_000_000n } });
    const transfers = executor.submit(intent({ amount: "2500000000" }));
    expect(transfers.map((t) => t.grossAmount)).toEqual(["1000000000", "1000000000", "500000000"]);
    expect(HYPERCORE_MAX_PER_TRANSFER).toBe(1_000_000_000n);
    expect(transfers.map((t) => t.transferId)).toEqual([`${intentId(1)}:0`, `${intentId(1)}:1`, `${intentId(1)}:2`]);
  });

  it("rejects a repeated intentId whose amount or route differs", () => {
    const { executor, store } = setup();
    executor.submit(intent({ amount: "500000000" }));
    expect(() => executor.submit(intent({ amount: "400000000" }))).toThrow(/different amount or route/);
    expect(() => executor.submit(intent({ route: "arc-solana" }))).toThrow(IntentRejected);
    expect(executor.submit(intent({ amount: "500000000" }))).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it("accepts a repeat of a split intent with the same total", () => {
    const { executor } = setup({ cfg: { defaultPerTransferCap: 200_000_000n } });
    executor.submit(intent({ amount: "500000000" }));
    expect(executor.submit(intent({ amount: "500000000" }))).toHaveLength(3);
  });

  it("honours a lower configured per-transfer cap", () => {
    const { executor } = setup({ cfg: { defaultPerTransferCap: 200_000_000n } });
    expect(executor.submit(intent({ amount: "500000000" }))).toHaveLength(3);
  });

  it("is idempotent per intentId", () => {
    const { executor, store } = setup();
    const first = executor.submit(intent());
    const second = executor.submit(intent());
    expect(second.map((t) => t.transferId)).toEqual(first.map((t) => t.transferId));
    expect(store.list()).toHaveLength(1);
  });

  it("enforces the daily cap across intents, all or nothing", () => {
    const { executor, store } = setup({ cfg: { dailyCap: 1_200_000_000n } });
    executor.submit(intent({ amount: "1000000000" }));
    expect(() => executor.submit(intent({ intentId: intentId(2), amount: "300000000" }))).toThrow(IntentRejected);
    expect(store.list()).toHaveLength(1);
    expect(executor.submit(intent({ intentId: intentId(3), amount: "200000000" }))).toHaveLength(1);
  });

  it("resets the daily cap on the next UTC day", () => {
    const { executor, time } = setup({ cfg: { dailyCap: 1_000_000_000n } });
    executor.submit(intent({ amount: "1000000000" }));
    time.advance(24 * 3600_000);
    expect(executor.submit(intent({ intentId: intentId(2), amount: "1000000000" }))).toHaveLength(1);
  });

  it("rejects destinations that are not allowlisted and unsupported routes", () => {
    const { executor } = setup({ cfg: { allowlist: new Set(["0xsomewhereelse"]) } });
    expect(() => executor.submit(intent())).toThrow(/allowlist/);
    expect(() => executor.submit(intent({ route: "hypercore-arc" }))).toThrow(/not supported/);
    expect(() => executor.submit(intent({ route: "solana-arc" }))).toThrow(/not supported/);
  });

  it("rejects a zero amount", () => {
    const { executor } = setup();
    expect(() => executor.submit(intent({ amount: "0" }))).toThrow(IntentRejected);
  });
});

describe("an armed withdrawal", () => {
  const armed = { status: "armed", amount: "500000000", nonce: "1" } as const;

  it("is not failed as expired once its validUntil has passed", async () => {
    const { executor, store, adapter, time } = setup();
    const [transfer] = executor.submit(intent(), { validUntil: new Date(time.now().getTime() + 60_000).toISOString() });
    store.setMeta(transfer!.transferId, { withdraw: armed });
    time.advance(120_000);
    await executor.advance(transfer!.transferId);
    expect(adapter.burns).toBe(1);
    expect(store.get(transfer!.transferId)!.state).not.toBe("failed");
  });

  it("still expires a request that was never armed", async () => {
    const { executor, store, adapter, time } = setup();
    const [transfer] = executor.submit(intent(), { validUntil: new Date(time.now().getTime() + 60_000).toISOString() });
    time.advance(120_000);
    await executor.advance(transfer!.transferId);
    expect(adapter.burns).toBe(0);
    expect(store.get(transfer!.transferId)!.state).toBe("failed");
  });

  it("holds the next HyperCore transfer while it is still requested", async () => {
    const { executor, store, adapter } = setup();
    const [first] = executor.submit(intent());
    const [second] = executor.submit(intent({ intentId: intentId(2) }));
    store.setMeta(first!.transferId, { withdraw: armed });
    expect((await executor.step(second!.transferId)).pending).toMatch(/previous HyperCore transfer/);
    expect(adapter.burns).toBe(0);
  });
});

describe("advance re-entrancy", () => {
  it("ignores a second advance for a transfer that is already being advanced", async () => {
    const { executor, adapter, store } = setup();
    const [transfer] = executor.submit(intent());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.burn = async () => {
      adapter.burns++;
      await gate;
      return { burnTx: "0xburn1" };
    };
    const first = executor.advance(transfer!.transferId);
    await executor.advance(transfer!.transferId);
    expect(adapter.burns).toBe(1);
    release();
    await first;
    expect(adapter.burns).toBe(1);
    expect(store.get(transfer!.transferId)!.state).not.toBe("requested");
  });
});

describe("HyperCore credit", () => {
  it("stays forwarded and pending while the HyperCore balance has not risen", async () => {
    const { executor, store, adapter } = setup();
    const [transfer] = executor.submit(intent());
    adapter.balance = 100_000_000n;
    await executor.advance(transfer!.transferId);
    const state = store.get(transfer!.transferId)!;
    expect(state.state).toBe("forwarded");
    expect(state.netMinted).toBe("499750000");
    expect(executor.pending()).toEqual([
      { transferId: transfer!.transferId, reason: expect.stringContaining("HyperCore balance has not risen") },
    ]);
    expect(store.inFlight()).toHaveLength(1);
  });

  it("does not credit a partial rise", async () => {
    const { executor, store, adapter } = setup();
    const [transfer] = executor.submit(intent());
    adapter.balance = 100_000_000n;
    await executor.advance(transfer!.transferId);
    adapter.balance = 100_000_000n + 100n;
    await executor.advance(transfer!.transferId);
    expect(store.get(transfer!.transferId)!.state).toBe("forwarded");
  });

  it("credits only once the balance rose by the net amount", async () => {
    const { executor, store, adapter } = setup();
    const [transfer] = executor.submit(intent());
    adapter.balance = 100_000_000n;
    await executor.advance(transfer!.transferId);
    adapter.balance = 100_000_000n + 499_750_000n;
    await executor.advance(transfer!.transferId);
    expect(store.get(transfer!.transferId)!.state).toBe("credited");
    expect(executor.pending()).toEqual([]);
    expect(store.inFlight()).toHaveLength(0);
  });

  it("sends chunks one at a time so one deposit cannot credit two transfers", async () => {
    const { executor, store, adapter } = setup({ cfg: { defaultPerTransferCap: 500_000_000n } });
    const transfers = executor.submit(intent({ amount: "1000000000" }));
    await executor.tick();
    expect(adapter.burns).toBe(1);
    expect(store.get(transfers[1]!.transferId)!.state).toBe("requested");
    adapter.balance = 499_750_000n;
    await executor.tick();
    expect(store.get(transfers[0]!.transferId)!.state).toBe("credited");
    await executor.tick();
    expect(adapter.burns).toBe(2);
  });

  it("waits for the Circle forwarder instead of assuming delivery", async () => {
    const { executor, store, adapter } = setup();
    adapter.deliverResult = { status: "pending", reason: "waiting for the Circle forwarder" };
    const [transfer] = executor.submit(intent());
    await executor.advance(transfer!.transferId);
    expect(store.get(transfer!.transferId)!.state).toBe("attested");
    expect(executor.pending()[0]?.reason).toMatch(/Circle forwarder/);
  });
});

describe("burn safety, timeouts and retry", () => {
  it("never burns twice for one transfer across ticks", async () => {
    const { executor, adapter } = setup();
    executor.submit(intent());
    await executor.tick();
    await executor.tick();
    await executor.tick();
    expect(adapter.burns).toBe(1);
  });

  it("does not arm the burn when the baseline read fails, so a retry can still burn once", async () => {
    const { executor, store, adapter } = setup();
    const [transfer] = executor.submit(intent());
    adapter.destinationBalance = async () => {
      throw new Error("info api down");
    };
    await executor.advance(transfer!.transferId);
    expect(adapter.burns).toBe(0);
    expect(store.canBurn(transfer!.transferId)).toBe(true);
  });

  it("refuses to re-burn after a crash between sending and recording", async () => {
    const path = tempJournal();
    const first = setup({ journal: path });
    const [transfer] = first.executor.submit(intent());
    first.adapter.failBurn = true;
    await first.executor.advance(transfer!.transferId);

    const second = setup({ journal: path });
    await second.executor.advance(transfer!.transferId);
    expect(second.adapter.burns).toBe(0);
    expect(second.executor.pending()[0]?.reason).toMatch(/burn outcome unknown/);
  });

  it("re-polls a stuck transfer after attestation timeout without burning again", async () => {
    const { executor, store, attester, adapter, time } = setup();
    attester.ready = false;
    const [transfer] = executor.submit(intent());
    await executor.advance(transfer!.transferId);
    expect(store.get(transfer!.transferId)!.state).toBe("burned");

    time.advance(2 * 60_000);
    await executor.tick();
    expect(store.get(transfer!.transferId)!.state).toBe("stuck");
    expect(store.inFlight()).toHaveLength(1);

    time.advance(10_000);
    attester.ready = true;
    await executor.tick();
    const after = store.get(transfer!.transferId)!;
    expect(["attested", "forwarded"]).toContain(after.state);
    expect(adapter.burns).toBe(1);
    expect(after.burnTx).toBe("0xburn1");
    expect(after.attester).toBe("local-test-attester");
  });
});

describe("other routes", () => {
  it("credits arc-solana after the destination mint", async () => {
    const { executor, store, adapter } = setup();
    adapter.deliverResult = { status: "done", state: "minted", tx: "0xsolmint" };
    const [transfer] = executor.submit(intent({ route: "arc-solana", amount: "5000000" }));
    await executor.advance(transfer!.transferId);
    const final = store.get(transfer!.transferId)!;
    expect(final.state).toBe("credited");
    expect(final.creditTx).toBe("0xsolmint");
  });
});
