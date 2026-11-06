import { SETTLED_TRANSFER_STATES, type BridgeTransfer, type TopUpIntent } from "@noirwire/shared";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { TreasuryExecutor, type DeliverResult, type ExecutorConfig, type RouteAdapter, type TransferView } from "../src/executor.ts";
import type { Attestation, Attester } from "../src/iris.ts";
import { TransferStore } from "../src/transfers.ts";
import { VaultTreasury } from "../src/vault.ts";
import { FakeVaultChain } from "./fake-vault.ts";
import { buildBurnMessage, tempJournal, word } from "./helpers.ts";

const VAULT = "0x00000000000000000000000000000000000000bb";
const TREASURY = "0x00000000000000000000000000000000000000aa";
const HYPERCORE = "0x00000000000000000000000000000000000000cc";
const FEE = 250_000n;
const START_LEDGER = 9_000_000_000n;
const START_HYPERCORE = 1_000_000_000n;

class SignedAttester implements Attester {
  label = "local-test-attester" as const;
  async fetchAttestation(query: { message?: Hex }): Promise<Attestation> {
    if (!query.message) return { status: "pending" };
    return { status: "complete", message: query.message, attestation: "0xabcd" };
  }
}

let nonce = 0;

class OutboundSim implements RouteAdapter {
  burns = 0;
  destination = 0n;
  private pendingCredit = 0n;
  gate: Promise<void> | undefined;
  started: (() => void) | undefined;

  constructor(private readonly chain: FakeVaultChain) {}

  async burn(transfer: BridgeTransfer) {
    this.started?.();
    await this.gate;
    this.burns++;
    this.chain.treasuryBalance -= BigInt(transfer.grossAmount);
    return { burnTx: `0xburn${this.burns}` };
  }
  async messageFor(transfer: BridgeTransfer) {
    return buildBurnMessage({
      sourceDomain: 26,
      destinationDomain: 19,
      amount: BigInt(transfer.grossAmount),
      feeExecuted: FEE,
      nonce: word(++nonce),
    });
  }
  async deliver(transfer: BridgeTransfer): Promise<DeliverResult> {
    this.pendingCredit = BigInt(transfer.grossAmount) - FEE;
    return { status: "done", state: "forwarded", tx: "0xforward" };
  }
  async destinationBalance() {
    this.destination += this.pendingCredit;
    this.pendingCredit = 0n;
    return this.destination;
  }
}

class ReturnSim implements RouteAdapter {
  source = START_HYPERCORE;

  constructor(private readonly chain: FakeVaultChain) {}

  async burn(transfer: BridgeTransfer) {
    this.source -= BigInt(transfer.grossAmount);
    return { burnTx: `0xreturn${transfer.transferId}` };
  }
  async messageFor(transfer: BridgeTransfer) {
    return buildBurnMessage({
      sourceDomain: 19,
      destinationDomain: 26,
      amount: BigInt(transfer.grossAmount),
      feeExecuted: FEE,
      nonce: word(++nonce),
    });
  }
  async deliver(transfer: BridgeTransfer): Promise<DeliverResult> {
    this.chain.surplus += BigInt(transfer.grossAmount) - FEE;
    return { status: "done", state: "minted", tx: "0xmint" };
  }
}

function intent(overrides: Partial<TopUpIntent> = {}): TopUpIntent {
  return {
    intentId: word(1),
    closeId: 1,
    route: "arc-hypercore",
    amount: "500000000",
    reason: "margin-low",
    marginRatioBps: 12000,
    ...overrides,
  };
}

function rig(journal = tempJournal(), chain = new FakeVaultChain(START_LEDGER)) {
  const store = new TransferStore(journal);
  const outbound = new OutboundSim(chain);
  const inbound = new ReturnSim(chain);
  const config: ExecutorConfig = {
    routes: {
      "arc-hypercore": { destination: HYPERCORE, maxFee: 300_000n },
      "hypercore-arc": { destination: VAULT, maxFee: 300_000n },
    },
    allowlist: new Set([HYPERCORE, VAULT]),
    dailyCap: 50_000_000_000n,
    defaultPerTransferCap: 1_000_000_000n,
    stuckTimeoutMs: 600_000,
    stuckRetryMs: 5_000,
    vault: new VaultTreasury(VAULT, TREASURY, chain),
  };
  const executor = new TreasuryExecutor(store, new SignedAttester(), { "arc-hypercore": outbound, "hypercore-arc": inbound }, config);
  return { journal, chain, store, outbound, inbound, executor };
}

type Rig = ReturnType<typeof rig>;

function navInTransit(r: Rig): bigint {
  let total = 0n;
  for (const transfer of r.store.list().map((t) => r.executor.view(t))) {
    if (!countsInTransit(transfer)) continue;
    total += BigInt(transfer.netMinted ?? transfer.grossAmount);
  }
  return total;
}

function countsInTransit(transfer: TransferView): boolean {
  if (SETTLED_TRANSFER_STATES.has(transfer.state)) return false;
  return transfer.released ?? transfer.state !== "requested";
}

function feesKnown(r: Rig): bigint {
  return r.store.list().reduce((sum, t) => sum + BigInt(t.feeExecuted ?? "0"), 0n);
}

function tracked(r: Rig): bigint {
  return r.chain.ledger + navInTransit(r) + r.outbound.destination + r.inbound.source + feesKnown(r);
}

function heldInBridgeWallet(r: Rig): bigint {
  return r.store
    .list()
    .map((t) => r.executor.view(t))
    .filter((t) => t.state === "requested" && t.released)
    .reduce((sum, t) => sum + BigInt(t.grossAmount), 0n);
}

const TOTAL = START_LEDGER + START_HYPERCORE;

describe("vault, in transit and destination always add up", () => {
  it("holds across every step of an arc-hypercore top-up, including the wallet before the burn", async () => {
    const r = rig();
    const [created] = r.executor.submit(intent());
    const id = (created as BridgeTransfer).transferId;
    expect(tracked(r)).toBe(TOTAL);

    let release!: () => void;
    r.outbound.gate = new Promise<void>((resolve) => (release = resolve));
    const reachedBurn = new Promise<void>((resolve) => (r.outbound.started = resolve));
    const running = r.executor.step(id);
    await reachedBurn;

    expect(r.store.get(id)?.state).toBe("requested");
    expect(r.executor.view(r.store.get(id) as BridgeTransfer).released).toBe(true);
    expect(r.chain.ledger).toBe(START_LEDGER - 500_000_000n);
    expect(r.chain.treasuryBalance).toBe(500_000_000n);
    expect(heldInBridgeWallet(r)).toBe(r.chain.treasuryBalance);
    expect(tracked(r)).toBe(TOTAL);

    release();
    await running;
    const seen: string[] = [r.store.get(id)?.state as string];
    expect(tracked(r)).toBe(TOTAL);
    expect(heldInBridgeWallet(r)).toBe(r.chain.treasuryBalance);

    for (let guard = 0; guard < 10 && r.store.get(id)?.state !== "credited"; guard++) {
      await r.executor.step(id);
      seen.push(r.store.get(id)?.state as string);
      expect(tracked(r)).toBe(TOTAL);
      expect(heldInBridgeWallet(r)).toBe(r.chain.treasuryBalance);
    }
    expect(seen).toEqual(["burned", "attested", "forwarded", "credited"]);
    expect(r.outbound.destination).toBe(500_000_000n - FEE);
    expect(r.chain.ledger).toBe(START_LEDGER - 500_000_000n);
    expect(r.outbound.burns).toBe(1);
  });

  it("holds across every step of a return into the vault and acknowledges exactly once", async () => {
    const r = rig();
    const [created] = r.executor.submit(intent({ route: "hypercore-arc", reason: "surplus-return", amount: "400000000" }));
    const id = (created as BridgeTransfer).transferId;
    expect(tracked(r)).toBe(TOTAL);

    const seen: string[] = [];
    for (let guard = 0; guard < 10 && r.store.get(id)?.state !== "credited"; guard++) {
      await r.executor.step(id);
      seen.push(r.store.get(id)?.state as string);
      expect(tracked(r)).toBe(TOTAL);
    }
    expect(seen).toEqual(["burned", "attested", "minted", "credited"]);
    expect(r.chain.sends).toBe(1);
    expect(r.chain.ledger).toBe(START_LEDGER + 400_000_000n - FEE);
    expect(r.chain.surplus).toBe(0n);

    await r.executor.step(id);
    await r.executor.tick();
    expect(r.chain.sends).toBe(1);
  });

  it("acknowledges once when the process dies after the acknowledgement left", async () => {
    const r = rig();
    const [created] = r.executor.submit(intent({ route: "hypercore-arc", reason: "surplus-return", amount: "400000000" }));
    const id = (created as BridgeTransfer).transferId;
    r.chain.crashAfterSend = true;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("minted");
    expect(r.executor.pending()[0]?.reason).toMatch(/died after/);

    r.chain.crashAfterSend = false;
    const restarted = rig(r.journal, r.chain);
    await restarted.executor.advance(id);
    expect(restarted.store.get(id)?.state).toBe("credited");
    expect(r.chain.sends).toBe(1);
    expect(r.chain.ledger).toBe(START_LEDGER + 400_000_000n - FEE);
  });
});

describe("releasing from the vault before the burn", () => {
  it("records a cap refusal on the transfer and never burns or retries", async () => {
    const r = rig();
    r.chain.perCall = 100n;
    const [created] = r.executor.submit(intent());
    const id = (created as BridgeTransfer).transferId;
    await r.executor.advance(id);

    const transfer = r.store.get(id) as BridgeTransfer;
    expect(transfer.state).toBe("failed");
    expect(transfer.error).toMatch(/vault refused the release: over the per-call move cap/);
    expect(r.executor.view(transfer).released).toBe(false);
    expect(r.outbound.burns).toBe(0);
    expect(r.chain.sends).toBe(0);
    expect(r.store.createdAmountOnDay(new Date().toISOString().slice(0, 10))).toBe(0n);

    await r.executor.tick();
    await r.executor.tick();
    expect(r.chain.simulations).toBe(1);
    expect(tracked(r)).toBe(TOTAL);
  });

  it("burns once when the process dies between the journal and the vault transaction", async () => {
    const r = rig();
    const [created] = r.executor.submit(intent());
    const id = (created as BridgeTransfer).transferId;
    r.chain.crashBeforeSend = true;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("requested");
    expect(r.store.meta(id)?.release?.status).toBe("armed");

    r.chain.crashBeforeSend = false;
    const restarted = rig(r.journal, r.chain);
    await restarted.executor.advance(id);
    expect(restarted.store.get(id)?.state).toBe("credited");
    expect(r.chain.sends).toBe(1);
    expect(restarted.outbound.burns).toBe(1);
    expect(r.chain.ledger).toBe(START_LEDGER - 500_000_000n);
  });

  it("releases once when the process dies after the vault transaction left", async () => {
    const r = rig();
    const [created] = r.executor.submit(intent());
    const id = (created as BridgeTransfer).transferId;
    r.chain.crashAfterSend = true;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("requested");
    expect(r.chain.treasuryBalance).toBe(500_000_000n);
    expect(r.store.meta(id)?.release?.txHash).toBeUndefined();

    r.chain.crashAfterSend = false;
    const restarted = rig(r.journal, r.chain);
    await restarted.executor.advance(id);
    expect(restarted.store.get(id)?.state).toBe("credited");
    expect(r.chain.sends).toBe(1);
    expect(restarted.outbound.burns).toBe(1);
    expect(r.chain.ledger).toBe(START_LEDGER - 500_000_000n);
  });

  it("releases each chunk of a split intent when its turn comes", async () => {
    const r = rig();
    r.chain.epochRoom = 10_000_000_000n;
    r.executor.submit(intent({ amount: "2500000000" }));
    expect(r.chain.sends).toBe(0);
    for (let guard = 0; guard < 30 && r.store.list().some((t) => t.state !== "credited"); guard++) await r.executor.tick();

    expect(r.store.list().map((t) => t.state)).toEqual(["credited", "credited", "credited"]);
    expect(r.chain.executed.map((entry) => entry.call.amount)).toEqual([1_000_000_000n, 1_000_000_000n, 500_000_000n]);
    expect(tracked(r)).toBe(TOTAL);
  });
});

describe("intents the bridge cannot serve", () => {
  it("records a route with no adapter as refused so a replay changes nothing", () => {
    const r = rig();
    const noReturn = new TreasuryExecutor(
      r.store,
      new SignedAttester(),
      { "arc-hypercore": r.outbound },
      {
        routes: { "arc-hypercore": { destination: HYPERCORE, maxFee: 300_000n } },
        allowlist: new Set([HYPERCORE]),
        dailyCap: 50_000_000_000n,
        defaultPerTransferCap: 1_000_000_000n,
        stuckTimeoutMs: 600_000,
        stuckRetryMs: 5_000,
      },
    );
    const request = intent({ route: "hypercore-arc", reason: "surplus-return" });
    expect(() => noReturn.submit(request)).toThrow(/not supported/);
    const first = noReturn.recordRefused(request, "route not available: route hypercore-arc is not supported");
    const second = noReturn.recordRefused(request, "ignored");
    expect(first.state).toBe("failed");
    expect(second.transferId).toBe(first.transferId);
    expect(r.store.list()).toHaveLength(1);
    expect(r.store.createdAmountOnDay(new Date().toISOString().slice(0, 10))).toBe(0n);
  });
});
