import type { FlowEvent } from "@noirwire/shared";
import { describe, expect, it } from "vitest";
import { aggregate, BUCKET_MS, isPublishable, PUBLISH_DELAY_MS, roundBtc8 } from "./privacy";

const NOW = Date.parse("2026-11-06T12:00:45.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function fill(id: string, side: "buy" | "sell", size: string, at: number): FlowEvent {
  return {
    kind: "fill",
    at: iso(at),
    fill: { fillId: id, market: "NBTC-PERP", makerSide: side, size, price: "100000", filledAt: iso(at) },
  };
}

function hl(
  cloid: string,
  side: "buy" | "sell",
  size: string,
  status: "pending" | "filled" | "rejected",
  at: number,
  sources: string[],
  filled = status === "filled" ? size : "0",
): FlowEvent {
  return {
    kind: "hedge",
    at: iso(at),
    order: {
      venue: "hyperliquid",
      cloid,
      coin: "BTC",
      assetIndex: 0,
      reduceOnly: false,
      tif: "Ioc",
      sourceFillIds: sources,
      side,
      size,
      limitPrice: "99700",
      status,
      filledSize: filled,
      createdAt: iso(at),
      updatedAt: iso(at),
    },
  };
}

function aquaRejected(at: number): FlowEvent {
  return {
    kind: "hedge",
    at: iso(at),
    order: {
      venue: "aqua",
      strategyHash: `0x${"ab".repeat(32)}`,
      maker: `0x${"11".repeat(20)}`,
      sourceFillIds: ["f1"],
      side: "sell",
      size: "1234567",
      limitPrice: "99700",
      status: "rejected",
      filledSize: "0",
      error: "guard",
      createdAt: iso(at),
      updatedAt: iso(at),
    },
  };
}

function exposure(at: number, maker: string, hlPos: string, aqua: string, net: string): FlowEvent {
  return {
    kind: "exposure",
    at: iso(at),
    exposure: { market: "NBTC-PERP", makerPosition: maker, hyperliquidPosition: hlPos, aquaInventory: aqua, netResidual: net, asOf: iso(at) },
  };
}

describe("roundBtc8", () => {
  it("rounds to 0.01 BTC, half away from zero", () => {
    expect(roundBtc8(1_234_567n)).toBe(1_000_000n);
    expect(roundBtc8(1_500_000n)).toBe(2_000_000n);
    expect(roundBtc8(-1_500_000n)).toBe(-2_000_000n);
    expect(roundBtc8(499_999n)).toBe(0n);
    expect(roundBtc8(-499_999n)).toBe(0n);
  });
});

describe("publication delay", () => {
  it("publishes only buckets that ended at least 20 s ago", () => {
    const start = Date.parse("2026-11-06T12:00:10.000Z");
    expect(isPublishable(start, NOW)).toBe(true);
    expect(isPublishable(start + BUCKET_MS, NOW)).toBe(false);
    expect(isPublishable(start + BUCKET_MS * 2, NOW)).toBe(false);
  });

  it("never includes a bucket younger than the delay", () => {
    const { buckets } = aggregate([exposure(NOW - 1000, "5000000", "-5000000", "0", "0")], NOW);
    const newest = buckets.at(-1);
    expect(Date.parse(newest?.start ?? "") + BUCKET_MS).toBeLessThanOrEqual(NOW - PUBLISH_DELAY_MS);
    expect(buckets.every((bucket) => bucket.residual === null)).toBe(true);
  });

  it("covers 15 minutes of 10 s buckets", () => {
    expect(aggregate([], NOW).buckets).toHaveLength(90);
  });
});

describe("aggregation", () => {
  const t = Date.parse("2026-11-06T12:00:03.000Z");
  const events: FlowEvent[] = [
    fill("f1", "buy", "3333333", t),
    fill("f2", "buy", "2222222", t + 2000),
    hl("c1", "sell", "3333333", "pending", t + 500, ["f1"]),
    hl("c1", "sell", "3333333", "filled", t + 1500, ["f1"]),
    hl("c2", "sell", "2222222", "filled", t + 3000, ["f2"]),
    exposure(t + 3000, "5555555", "-5555555", "0", "0"),
  ];

  it("nets hedges per bucket and counts each order once", () => {
    const bucket = aggregate(events, NOW).buckets.find((b) => b.hedges.length > 0);
    expect(bucket?.start).toBe("2026-11-06T12:00:00.000Z");
    expect(bucket?.hedges).toEqual([{ venue: "hyperliquid", net: "-6000000", orders: 2, rejected: 0 }]);
    expect(bucket?.makerFlow).toBe("6000000");
  });

  it("carries the last exposure forward, rounded", () => {
    const { buckets } = aggregate(events, NOW);
    const last = buckets.at(-1);
    expect(last?.makerPosition).toBe("6000000");
    expect(last?.hyperliquidPosition).toBe("-6000000");
    expect(last?.residual).toBe("0");
    expect(buckets[0]?.residual).toBeNull();
  });

  it("counts Aqua guard rejections as rejected, not as filled", () => {
    const bucket = aggregate([fill("f1", "buy", "1234567", t), aquaRejected(t + 1000)], NOW).buckets.find((b) => b.hedges.length);
    expect(bucket?.hedges).toEqual([{ venue: "aqua", net: "0", orders: 1, rejected: 1 }]);
  });

  it("reports hedge latency in whole seconds", () => {
    expect(aggregate(events, NOW).latencySeconds).toBe(1);
    expect(aggregate([], NOW).latencySeconds).toBeNull();
  });

  it("computes latency only from publishable orders, in whole seconds", () => {
    const old = Date.parse("2026-11-06T12:00:03.000Z");
    const base = [fill("f1", "buy", "3333333", old), hl("c1", "sell", "3333333", "filled", old + 2400, ["f1"])];
    const recent = [fill("f9", "buy", "9000000", NOW - 9000), hl("c9", "sell", "9000000", "filled", NOW - 1000, ["f9"])];
    const latency = aggregate([...base, ...recent], NOW).latencySeconds;
    expect(latency).toBe(2);
    expect(Number.isInteger(latency)).toBe(true);
  });

  it("publishes nothing from a bucket that is still inside the delay", () => {
    const recent = [fill("f9", "buy", "9000000", NOW - 5000), hl("c9", "sell", "9000000", "filled", NOW - 4000, ["f9"])];
    const { buckets } = aggregate(recent, NOW);
    expect(buckets.every((bucket) => bucket.hedges.length === 0 && bucket.makerFlow === "0")).toBe(true);
  });

  it("leaks no raw size, id or timestamp", () => {
    const text = JSON.stringify(aggregate([...events, aquaRejected(t + 1000)], NOW));
    for (const raw of ["3333333", "2222222", "5555555", "1234567", "f1", "f2", "c1", "c2", "abab", "guard", "100000", "99700"]) {
      expect(text).not.toContain(raw);
    }
    const stamps = text.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) expect(Date.parse(stamp) % BUCKET_MS).toBe(0);
    const sizes = [...text.matchAll(/"(?:makerPosition|hyperliquidPosition|aquaInventory|residual|makerFlow|net)":"(-?\d+)"/g)];
    for (const match of sizes) expect(BigInt(match[1] ?? "0") % 1_000_000n).toBe(0n);
  });
});
