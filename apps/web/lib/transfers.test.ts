import type { BridgeTransfer } from "@noirwire/shared";
import { describe, expect, it } from "vitest";
import { PUBLISH_DELAY_MS } from "./privacy";
import { moveFor, publicTransfers, railFor } from "./transfers";

const NOW = Date.parse("2026-11-06T12:05:45.000Z");

function transfer(overrides: Partial<BridgeTransfer>): BridgeTransfer {
  return {
    transferId: "t-secret-1",
    route: "arc-solana",
    sourceDomain: 26,
    destinationDomain: 5,
    grossAmount: "1000000",
    maxFee: "1000",
    state: "burned",
    burnTx: "0xabc",
    attester: "circle-iris",
    updatedAt: "2026-11-06T12:03:27.456Z",
    ...overrides,
  };
}

describe("public transfers", () => {
  it("floors every published time to the minute", () => {
    const [published] = publicTransfers([transfer({})], NOW);
    expect(published?.updatedAt).toBe("2026-11-06T12:03:00.000Z");
    const stamps = published?.rail.nodes.flatMap((node) => (node.at ? [node.at] : [])) ?? [];
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) expect(Date.parse(stamp) % 60_000).toBe(0);
  });

  it("holds a transfer back until it is 20 s old", () => {
    const young = transfer({ updatedAt: new Date(NOW - PUBLISH_DELAY_MS + 1000).toISOString() });
    const old = transfer({ updatedAt: new Date(NOW - PUBLISH_DELAY_MS).toISOString() });
    expect(publicTransfers([young], NOW)).toHaveLength(0);
    expect(publicTransfers([old], NOW)).toHaveLength(1);
  });

  it("maps errors to a fixed vocabulary", () => {
    const failed = railFor(transfer({ state: "failed", error: "RPC http://10.0.0.5:8545 timed out 0xdeadbeef" }));
    expect(failed.terminal?.error).toBe("failed");
    const refunded = railFor(transfer({ state: "failed", error: "burn reverted, funds Refunded to sender" }));
    expect(refunded.terminal?.error).toBe("refunded");
    const waiting = railFor(transfer({ state: "stuck", error: "iris 404 for https://iris.internal/x" }));
    expect(waiting.terminal?.error).toBe("waiting for attestation");
    expect(JSON.stringify([failed, refunded, waiting])).not.toMatch(/10\.0\.0\.5|iris\.internal|deadbeef/);
  });
});

describe("rebalancing moves", () => {
  it("words every route", () => {
    expect(moveFor(transfer({ route: "arc-hypercore" }))).toMatchObject({ direction: "Vault to Hyperliquid margin", why: "margin top-up" });
    expect(moveFor(transfer({ route: "hypercore-arc" }))).toMatchObject({ direction: "Hyperliquid surplus back to vault", why: "surplus" });
    expect(moveFor(transfer({ route: "arc-solana" }))).toMatchObject({ direction: "Arc to Solana", why: null });
    expect(moveFor(transfer({ route: "solana-arc" }))).toMatchObject({ direction: "Solana to Arc", why: null });
  });

  it("words every state", () => {
    const step = (state: BridgeTransfer["state"], extra: Partial<BridgeTransfer> = {}, route: BridgeTransfer["route"] = "arc-hypercore") =>
      moveFor(transfer({ state, route, ...extra })).step;
    expect(step("requested", { released: true })).toBe("Released from vault");
    expect(step("requested")).toBe("Requested");
    expect(step("burned")).toBe("Burned");
    expect(step("attested")).toBe("Circle signed");
    for (const state of ["minted", "hook-executed", "forwarded"] as const) expect(step(state)).toBe("Delivered");
    expect(step("credited")).toBe("Credited");
    for (const state of ["vault-credited", "claimable", "credited"] as const) expect(step(state, {}, "hypercore-arc")).toBe("Returned to vault");
    expect(step("stuck")).toBe("Stalled");
    expect(step("failed", { error: "something broke" })).toBe("Failed");
    expect(step("failed", { error: "funds refunded" })).toBe("Refunded");
  });

  it("shows a refused release plainly without the raw error", () => {
    const refused = transfer({ route: "arc-hypercore", state: "failed", error: "vault refused the release: cap https://rpc.internal/x 0xdead" });
    const move = moveFor(refused);
    expect(move.step).toBe("Refused");
    expect(move.refused).toBe("The vault declined to release the funds, so nothing moved.");
    expect(railFor(refused).terminal?.error).toBe("refused");
    expect(JSON.stringify([move, railFor(refused)])).not.toMatch(/rpc\.internal|0xdead/);
  });

  it("keeps the delay and minute floor on moves", () => {
    const young = transfer({ route: "arc-hypercore", updatedAt: new Date(NOW - PUBLISH_DELAY_MS + 1000).toISOString() });
    const old = transfer({ route: "arc-hypercore", released: true, state: "requested", updatedAt: "2026-11-06T12:03:27.456Z" });
    const published = publicTransfers([young, old], NOW);
    expect(published).toHaveLength(1);
    expect(published[0]?.updatedAt).toBe("2026-11-06T12:03:00.000Z");
    expect(published[0]?.move.step).toBe("Released from vault");
  });
});
