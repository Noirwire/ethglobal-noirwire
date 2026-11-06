import { describe, expect, it } from "vitest";
import { parseHedgerStatus, parseNavSnapshot, parseTransfers, SseParser } from "./parse";
import { computeSourcesHash } from "./nav-hash";
import { railFor } from "./transfers";

const transfer = {
  transferId: "t1",
  route: "arc-solana",
  sourceDomain: 26,
  destinationDomain: 5,
  grossAmount: "5000000000",
  maxFee: "1000",
  state: "attested",
  burnTx: "0xabc",
  attester: "local-test-attester",
  updatedAt: "2026-11-06T10:00:00.000Z",
};

describe("response parsing", () => {
  it("accepts a hedger status and drops unlisted fields", () => {
    const parsed = parseHedgerStatus({ status: "hedged", hedgeEnabled: true, market: "NBTC-PERP", netResidual: "0.0001" });
    expect(parsed).toEqual({ ok: true, data: { status: "hedged", hedgeEnabled: true, market: "NBTC-PERP" } });
  });

  it("rejects a malformed status with a reason", () => {
    const parsed = parseHedgerStatus({ status: "great" });
    expect(parsed.ok).toBe(false);
  });

  it("parses bridge transfers and rejects a bad array", () => {
    expect(parseTransfers([transfer]).ok).toBe(true);
    const bad = parseTransfers([{ ...transfer, attester: "someone" }]);
    expect(bad.ok).toBe(false);
    expect(parseTransfers({}).ok).toBe(false);
  });

  it("rejects a NAV snapshot without sources", () => {
    expect(parseNavSnapshot({ closeId: 1 }).ok).toBe(false);
  });
});

describe("SseParser", () => {
  const exposure = {
    kind: "exposure",
    at: "2026-11-06T10:00:00.000Z",
    exposure: {
      market: "NBTC-PERP",
      makerPosition: "1",
      hyperliquidPosition: "-1",
      aquaInventory: "0",
      netResidual: "0",
      asOf: "2026-11-06T10:00:00.000Z",
    },
  };

  it("reassembles events split across chunks and skips junk", () => {
    const parser = new SseParser();
    const frame = `data: ${JSON.stringify(exposure)}\n\n`;
    expect(parser.push(": connected\n\n")).toEqual([]);
    expect(parser.push(frame.slice(0, 20))).toEqual([]);
    expect(parser.push(frame.slice(20))).toHaveLength(1);
    expect(parser.push('data: {"kind":"nope"}\n\ndata: not json\n\n')).toEqual([]);
    expect(parser.skipped).toBe(2);
  });
});

describe("transfer rail", () => {
  it("marks reached stages from the state and links only public chains", () => {
    const parsed = parseTransfers([transfer]);
    if (!parsed.ok) throw new Error("fixture invalid");
    const rail = railFor(parsed.data[0]!);
    expect(rail.nodes.map((n) => n.reached)).toEqual([true, true, false, false]);
    expect(rail.nodes[0]?.href).toBeNull();
    expect(rail.nodes[1]?.at).toBe("2026-11-06T10:00:00.000Z");
  });

  it("links an Iris burn to the Arc explorer", () => {
    const parsed = parseTransfers([{ ...transfer, attester: "circle-iris", state: "failed", error: "boom" }]);
    if (!parsed.ok) throw new Error("fixture invalid");
    const rail = railFor(parsed.data[0]!);
    expect(rail.nodes[0]?.href).toContain("/tx/0xabc");
    expect(rail.terminal).toEqual({ kind: "failed", error: "boom" });
  });
});

describe("sources hash", () => {
  it("matches the golden value used by the CRE workflow", () => {
    const hash = computeSourcesHash([
      { leg: "arc-vault-cash", account: "arc:x", assets: "5000000000", liabilities: "0", observedAt: new Date(1793948000 * 1000).toISOString(), trust: "onchain" },
      { leg: "solana-maker", account: "solana:m", assets: "12000000000", liabilities: "0", observedAt: new Date(1793948010 * 1000).toISOString(), trust: "operator-supplied" },
    ]);
    expect(hash).toBe("0x1eeb1cd2ecbf4c5e0bd326fee5b8a9825b8163d37c6ab480ed2ee31f2947d902");
  });
});
