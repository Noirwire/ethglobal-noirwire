import { describe, expect, it } from "vitest";
import { HedgeController } from "../src/controller.ts";
import { EventBus } from "../src/events.ts";
import { Journal, MemoryJournalStore, type JournalOrder } from "../src/journal.ts";
import { limitPrice } from "../src/order-sizing.ts";
import { resolveOrder } from "../src/reconcile.ts";
import { parsePositionResponse } from "../src/sources/tape.ts";
import type { FillBatch, FillSource, HedgeVenue, VenueFill } from "../src/types.ts";
import { HyperliquidVenue, type HlExchangeLike, type HlInfoLike } from "../src/venue/hyperliquid-venue.ts";
import { MockVenue } from "../src/venue/mock-venue.ts";
import { counterCloids, fakeInfo, MARK_PX8, START_MS, TestClock } from "./harness.ts";

const BTC = 100_000_000n;
const ACCOUNT = `0x${"11".repeat(20)}` as const;
const CLOID = `0x${"0".repeat(31)}1` as const;

class ScriptedPositionSource implements FillSource {
  readonly reportsPosition = true;
  next: FillBatch = { fills: [], cursor: "" };
  async poll(): Promise<FillBatch> {
    return this.next;
  }
  async commit(): Promise<void> {}
}

function positionController() {
  const clock = new TestClock();
  const venue = new MockVenue({ markPx8: MARK_PX8, accountValue6: 50_000_000_000n, clock: clock.now });
  const source = new ScriptedPositionSource();
  const controller = new HedgeController({
    venue,
    fillSource: source,
    journal: new Journal(new MemoryJournalStore()),
    bus: new EventBus(),
    clock: clock.now,
    newCloid: counterCloids(),
  });
  const report = (position8: bigint, ageMs: number) => {
    source.next = { fills: [], cursor: "", makerPosition8: position8, makerPositionObservedAtMs: clock.now() - ageMs };
  };
  return { clock, venue, controller, report };
}

describe("maker position freshness", () => {
  it("parses observedAt into epoch milliseconds", () => {
    const parsed = parsePositionResponse({ market: "NBTC-PERP", size: "0.05", observedAt: "2026-11-06T08:00:00.000Z" });
    expect(parsed.observedAtMs).toBe(Date.parse("2026-11-06T08:00:00.000Z"));
    expect(() => parsePositionResponse({ market: "NBTC-PERP", size: "0.05", observedAt: "yesterday" })).toThrow();
  });

  it("holds when the reported position is older than the max age", async () => {
    const h = positionController();
    h.report(5_000_000n, 20_000);
    const tick = await h.controller.tick();
    expect(tick.decision).toBe("hold:maker-position-unknown");
    expect(h.venue.placeCalls).toHaveLength(0);
    expect(h.controller.makerPosition8).toBe(0n);
  });

  it("holds when a position older than the last accepted one arrives", async () => {
    const h = positionController();
    h.report(-5_000_000n, 0);
    await h.controller.tick();
    expect(h.venue.truePosition8).toBe(5_000_000n);

    h.clock.advance(1_000);
    h.report(5_000_000n, 5_000);
    const tick = await h.controller.tick();
    expect(tick.decision).toBe("hold:maker-position-unknown");
    expect(h.venue.placeCalls).toHaveLength(1);
    expect(h.venue.truePosition8).toBe(5_000_000n);

    h.clock.advance(1_000);
    h.report(-5_000_000n, 0);
    await h.controller.tick();
    expect(h.venue.truePosition8).toBe(5_000_000n);
  });
});

describe("hyperliquid fills carry the cloid", () => {
  function info(fills: Awaited<ReturnType<HlInfoLike["userFillsByTime"]>>, orderOid?: number): HlInfoLike {
    return fakeInfo({
      orderStatus: async () =>
        orderOid === undefined
          ? { status: "unknownOid" as const }
          : {
              status: "order" as const,
              order: { status: "filled", order: { origSz: "0.01", sz: "0", oid: orderOid } },
            },
      userFillsByTime: async () => fills,
    });
  }

  it("uses the cloid the venue reports on the fill", async () => {
    const venue = await HyperliquidVenue.connect({
      coin: "BTC",
      accountAddress: ACCOUNT,
      info: info([{ coin: "BTC", px: "100000", sz: "0.01", side: "B", time: 5, tid: 9, oid: 4, cloid: CLOID }]),
      exchange: null,
    });
    expect((await venue.fillsSince(0))[0]?.cloid).toBe(CLOID);
  });

  it("maps an oid learned from the place response back to the cloid", async () => {
    const exchange: HlExchangeLike = {
      order: async () => ({ response: { data: { statuses: [{ filled: { totalSz: "0.01", avgPx: "100100", oid: 77 } }] } } }),
      cancelByCloid: async () => ({ response: { data: { statuses: ["success"] } } }),
    };
    const venue = await HyperliquidVenue.connect({
      coin: "BTC",
      accountAddress: ACCOUNT,
      info: info([{ coin: "BTC", px: "100100", sz: "0.01", side: "B", time: 5, tid: 9, oid: 77 }]),
      exchange,
    });
    await venue.placeIoc({ cloid: CLOID, side: "buy", size8: 1_000_000n, limitPx8: 100_200n * BTC, reduceOnly: false });
    expect((await venue.fillsSince(0))[0]?.cloid).toBe(CLOID);
  });

  it("maps an oid learned from the order status back to the cloid", async () => {
    const venue = await HyperliquidVenue.connect({
      coin: "BTC",
      accountAddress: ACCOUNT,
      info: info([{ coin: "BTC", px: "100100", sz: "0.01", side: "B", time: 5, tid: 9, oid: 88 }], 88),
      exchange: null,
    });
    await venue.orderStatusByCloid(CLOID);
    expect((await venue.fillsSince(0))[0]?.cloid).toBe(CLOID);
  });
});

describe("order reconciliation never invents absence", () => {
  const order: JournalOrder = {
    cloid: CLOID,
    side: "buy",
    size8: 1_000_000n,
    limitPx8: 100_200n * BTC,
    reduceOnly: false,
    positionBefore8: 0n,
    sourceFillIds: [],
    intentAt: START_MS,
    settled: false,
    filled8: 0n,
  };

  function venueWith(fillsSince: () => Promise<VenueFill[]>): HedgeVenue {
    return {
      fillsSince,
      orderStatusByCloid: async () => ({ state: "unknown", filled8: 0n }),
    } as unknown as HedgeVenue;
  }

  const later = START_MS + 60_000;

  it("stays pending when the fill query fails", async () => {
    const venue = venueWith(async () => {
      throw new Error("info down");
    });
    expect((await resolveOrder(venue, order, later, 10_000, () => {})).kind).toBe("pending");
  });

  it("stays pending when a same-side fill cannot be attributed to any cloid", async () => {
    const venue = venueWith(async () => [{ id: "4:9", side: "buy", size8: 1_000_000n, px8: MARK_PX8, time: START_MS + 5 }]);
    expect((await resolveOrder(venue, order, later, 10_000, () => {})).kind).toBe("pending");
  });

  it("settles as not placed when the queries succeed and show nothing", async () => {
    const venue = venueWith(async () => []);
    expect(await resolveOrder(venue, order, later, 10_000, () => {})).toMatchObject({ kind: "settled", final: "not-placed" });
  });
});

describe("limit price stays inside the band", () => {
  const mark = 100_123n * BTC;
  const bandMax = (mark * 10_001n) / 10_000n;

  it("rounds a buy down to the tick instead of past the band", () => {
    const px = limitPrice(mark, "buy", 1, 5);
    expect(px).not.toBeNull();
    expect(px as bigint).toBeLessThanOrEqual(bandMax);
    expect(px as bigint).toBe(100_133n * BTC);
  });

  it("rounds a sell up to the tick instead of past the band", () => {
    const bandMin = (mark * 9_999n) / 10_000n;
    expect(limitPrice(mark, "sell", 1, 5) as bigint).toBeGreaterThanOrEqual(bandMin);
  });

  it("holds when the inward price no longer crosses the mark", () => {
    expect(limitPrice(105_000_000n, "buy", 1, 5)).toBeNull();
    expect(limitPrice(100_000_000n, "buy", 1, 5)).toBe(100_000_000n);
  });
});
