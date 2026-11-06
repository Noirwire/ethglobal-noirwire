import type { BridgeTransfer } from "@noirwire/shared";
import { describe, expect, it } from "vitest";
import { PUBLISH_DELAY_MS } from "./privacy";
import { publicTransfers, railFor } from "./transfers";

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
