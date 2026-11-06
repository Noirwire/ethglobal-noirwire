import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IllegalTransition, TransferStore } from "../src/transfers.ts";
import { clock, newTransfer, tempJournal, word } from "./helpers.ts";

const hash = (n: number) => word(n);

function walkToAttested(store: TransferStore, id = "t1", messageHash = hash(1)) {
  store.transition(id, "burned", { burnTx: "0xburn" });
  store.transition(id, "attested", { messageHash, attestation: "0xsig" });
}

describe("transfer state machine", () => {
  it("walks the solana-arc deposit path", () => {
    const store = new TransferStore();
    store.create(newTransfer());
    walkToAttested(store);
    store.transition("t1", "hook-executed", { mintTx: "0xmint" });
    expect(store.transition("t1", "vault-credited").state).toBe("vault-credited");
  });

  it("walks the arc-hypercore path and only credits after forwarded", () => {
    const store = new TransferStore();
    store.create(newTransfer({ route: "arc-hypercore", sourceDomain: 26, destinationDomain: 19 }));
    walkToAttested(store);
    expect(() => store.transition("t1", "credited")).toThrow(IllegalTransition);
    store.transition("t1", "forwarded");
    expect(store.transition("t1", "credited").state).toBe("credited");
  });

  it.each([
    ["requested", "attested"],
    ["requested", "credited"],
    ["burned", "minted"],
    ["burned", "vault-credited"],
  ] as const)("rejects %s -> %s", (from, to) => {
    const store = new TransferStore();
    store.create(newTransfer());
    if (from === "burned") store.transition("t1", "burned", { burnTx: "0xburn" });
    expect(() => store.transition("t1", to, { messageHash: hash(2), attestation: "0x1" })).toThrow(IllegalTransition);
  });

  it("rejects route-specific illegal targets and terminal exits", () => {
    const store = new TransferStore();
    store.create(newTransfer());
    walkToAttested(store);
    expect(() => store.transition("t1", "forwarded")).toThrow(IllegalTransition);
    store.transition("t1", "hook-executed");
    store.transition("t1", "claimable");
    expect(() => store.transition("t1", "failed")).toThrow(IllegalTransition);
  });

  it("requires a burn tx to be burned and an attestation to be attested", () => {
    const store = new TransferStore();
    store.create(newTransfer());
    expect(() => store.transition("t1", "burned")).toThrow(/burn tx/);
    store.transition("t1", "burned", { burnTx: "0xburn" });
    expect(() => store.transition("t1", "attested")).toThrow(/attestation/);
  });

  it("is idempotent by transferId", () => {
    const store = new TransferStore();
    store.create(newTransfer());
    store.transition("t1", "burned", { burnTx: "0xburn" });
    const again = store.create(newTransfer());
    expect(again.state).toBe("burned");
    expect(again.burnTx).toBe("0xburn");
    expect(store.list()).toHaveLength(1);
  });

  it("refuses to change a burn tx or reuse a message hash", () => {
    const store = new TransferStore();
    store.create(newTransfer());
    store.create(newTransfer({ transferId: "t2" }));
    walkToAttested(store, "t1", hash(7));
    store.transition("t2", "burned", { burnTx: "0xother" });
    expect(() => store.transition("t2", "attested", { messageHash: hash(7), attestation: "0x1" })).toThrow(/already belongs/);
    expect(() => store.transition("t1", "hook-executed", { burnTx: "0xchanged" })).toThrow(/immutable/);
  });
});

describe("in-flight accounting", () => {
  it("counts each transfer once, by state, and drops settled ones", () => {
    const store = new TransferStore();
    for (const id of ["a", "b", "c", "d"]) store.create(newTransfer({ transferId: id }));
    store.transition("b", "burned", { burnTx: "0x1" });
    store.transition("c", "burned", { burnTx: "0x2" });
    store.transition("c", "attested", { messageHash: hash(3), attestation: "0x1" });
    store.transition("c", "hook-executed");
    store.transition("c", "vault-credited");
    store.transition("d", "failed");
    const ids = store.inFlight().map((t) => t.transferId).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("keeps a stuck transfer in flight", () => {
    const store = new TransferStore();
    store.create(newTransfer({ transferId: "a" }));
    store.transition("a", "burned", { burnTx: "0x1" });
    store.markStuck("a", "slow");
    expect(store.inFlight().map((t) => t.transferId)).toEqual(["a"]);
  });
});

describe("journal replay", () => {
  it("restores state after a crash mid-transfer", () => {
    const path = tempJournal();
    const first = new TransferStore(path);
    first.create(newTransfer());
    walkToAttested(first, "t1", hash(5));

    const restarted = new TransferStore(path);
    expect(restarted.get("t1")?.state).toBe("attested");
    expect(restarted.get("t1")?.burnTx).toBe("0xburn");
    expect(restarted.findByMessageHash(hash(5))?.transferId).toBe("t1");
    expect(restarted.inFlight()).toHaveLength(1);
    restarted.transition("t1", "hook-executed");
    expect(new TransferStore(path).get("t1")?.state).toBe("hook-executed");
  });

  it("ignores a torn final line", () => {
    const path = tempJournal();
    const store = new TransferStore(path);
    store.create(newTransfer());
    writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":99,"op":"upd`);
    expect(new TransferStore(path).get("t1")?.state).toBe("requested");
  });

  it("never re-burns after a restart, even when the burn tx was never recorded", () => {
    const path = tempJournal();
    const first = new TransferStore(path);
    first.create(newTransfer());
    first.beginBurn("t1");

    const restarted = new TransferStore(path);
    expect(restarted.canBurn("t1")).toBe(false);
    expect(() => restarted.beginBurn("t1")).toThrow(IllegalTransition);
  });

  it("never re-burns a transfer that already has a burn tx", () => {
    const path = tempJournal();
    const first = new TransferStore(path);
    first.create(newTransfer());
    first.beginBurn("t1");
    first.transition("t1", "burned", { burnTx: "0xburn" });
    first.markStuck("t1", "timeout");
    const restarted = new TransferStore(path);
    restarted.resume("t1");
    expect(restarted.get("t1")?.state).toBe("burned");
    expect(restarted.canBurn("t1")).toBe(false);
  });
});

describe("timeouts", () => {
  it("moves stale transfers to stuck and resumes them where they were", () => {
    const time = clock();
    const store = new TransferStore(undefined, time.now);
    store.create(newTransfer());
    store.transition("t1", "burned", { burnTx: "0xburn" });
    time.advance(10 * 60_000);
    const moved = store.expireStale({}, 5 * 60_000);
    expect(moved.map((t) => t.state)).toEqual(["stuck"]);
    expect(store.inFlight()).toHaveLength(1);
    expect(store.resume("t1").state).toBe("burned");
    expect(store.get("t1")?.error).toBeUndefined();
  });

  it("leaves fresh and settled transfers alone", () => {
    const time = clock();
    const store = new TransferStore(undefined, time.now);
    store.create(newTransfer());
    store.create(newTransfer({ transferId: "done" }));
    store.transition("done", "failed");
    time.advance(60_000);
    expect(store.expireStale({}, 5 * 60_000)).toHaveLength(0);
  });

  it("only resumes a stuck transfer", () => {
    const store = new TransferStore();
    store.create(newTransfer());
    expect(() => store.resume("t1")).toThrow(IllegalTransition);
  });
});
