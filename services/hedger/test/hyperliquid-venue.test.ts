import { describe, expect, it } from "vitest";
import {
  HyperliquidVenue,
  type HlExchangeLike,
  type HlInfoLike,
  type HlOrderParams,
  type HlOrderStatusEntry,
} from "../src/venue/hyperliquid-venue.ts";

const ACCOUNT = `0x${"11".repeat(20)}` as const;
const CLOID = `0x${"0".repeat(31)}1` as const;
const BTC = 100_000_000n;

function fakeInfo(overrides: Partial<HlInfoLike> = {}): HlInfoLike {
  const universe = [
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  ];
  return {
    meta: async () => ({ universe }),
    metaAndAssetCtxs: async () => [{ universe }, [{ markPx: "3000.5" }, { markPx: "100123.0" }]],
    clearinghouseState: async () => ({
      marginSummary: { accountValue: "1234.567891", totalMarginUsed: "250.5" },
      withdrawable: "900.1",
      assetPositions: [
        { position: { coin: "ETH", szi: "1.5" } },
        { position: { coin: "BTC", szi: "-0.01234" } },
      ],
    }),
    orderStatus: async () => ({ status: "unknownOid" as const }),
    userFillsByTime: async () => [],
    ...overrides,
  };
}

function fakeExchange(statuses: HlOrderStatusEntry[]) {
  const orders: HlOrderParams[] = [];
  const cancels: unknown[] = [];
  const exchange: HlExchangeLike = {
    order: async (params) => {
      orders.push(params);
      return { response: { data: { statuses } } };
    },
    cancelByCloid: async (params) => {
      cancels.push(params);
      return { response: { data: { statuses: ["success"] } } };
    },
  };
  return { exchange, orders, cancels };
}

async function connect(info: HlInfoLike, exchange: HlExchangeLike | null) {
  return HyperliquidVenue.connect({ coin: "BTC", accountAddress: ACCOUNT, info, exchange });
}

describe("HyperliquidVenue reads", () => {
  it("resolves the BTC asset index, szDecimals and leverage from meta", async () => {
    const venue = await connect(fakeInfo(), null);
    expect(venue.spec).toMatchObject({ coin: "BTC", assetIndex: 1, szDecimals: 5, maxLeverage: 40 });
  });

  it("fails when the coin is not listed", async () => {
    await expect(
      HyperliquidVenue.connect({ coin: "DOGE", accountAddress: ACCOUNT, info: fakeInfo(), exchange: null }),
    ).rejects.toThrow(/no DOGE perp/);
  });

  it("reads the signed BTC position and ignores other coins", async () => {
    const venue = await connect(fakeInfo(), null);
    expect(await venue.position()).toBe(-1_234_000n);
  });

  it("reads account state with the mark price of the BTC context", async () => {
    const venue = await connect(fakeInfo(), null);
    expect(await venue.accountState()).toEqual({
      accountValue6: 1_234_567_891n,
      totalMarginUsed6: 250_500_000n,
      withdrawable6: 900_100_000n,
      markPx8: 100_123n * BTC,
    });
  });

  it("maps order status by cloid", async () => {
    const info = fakeInfo({
      orderStatus: async () => ({
        status: "order" as const,
        order: { status: "canceled", order: { origSz: "0.01", sz: "0.004" } },
      }),
    });
    const venue = await connect(info, null);
    expect(await venue.orderStatusByCloid(CLOID)).toMatchObject({ state: "cancelled", filled8: 600_000n });
    expect((await connect(fakeInfo(), null).then((v) => v.orderStatusByCloid(CLOID))).state).toBe("unknown");
  });

  it("maps fills of the BTC perp only", async () => {
    const info = fakeInfo({
      userFillsByTime: async () => [
        { coin: "BTC", px: "100000.0", sz: "0.01", side: "A" as const, time: 5, tid: 9, oid: 4 },
        { coin: "ETH", px: "3000", sz: "1", side: "B" as const, time: 6, tid: 10, oid: 5 },
      ],
    });
    const fills = await (await connect(info, null)).fillsSince(0);
    expect(fills).toEqual([{ id: "4:9", side: "sell", size8: 1_000_000n, px8: 100_000n * BTC, time: 5 }]);
  });
});

describe("HyperliquidVenue orders", () => {
  it("sends an IOC limit order with the cloid, asset index and plain decimal strings", async () => {
    const { exchange, orders } = fakeExchange([{ filled: { totalSz: "0.01", avgPx: "100100", oid: 77 } }]);
    const venue = await connect(fakeInfo(), exchange);

    const result = await venue.placeIoc({
      cloid: CLOID,
      side: "sell",
      size8: 1_000_000n,
      limitPx8: 99_800n * BTC,
      reduceOnly: true,
    });

    expect(orders[0]).toEqual({
      orders: [{ a: 1, b: false, p: "99800", s: "0.01", r: true, t: { limit: { tif: "Ioc" } }, c: CLOID }],
      grouping: "na",
    });
    expect(result).toEqual({ outcome: "filled", filled8: 1_000_000n, avgPx8: 100_100n * BTC });
  });

  it("reports a partial fill and a rejection", async () => {
    const partial = await connect(fakeInfo(), fakeExchange([{ filled: { totalSz: "0.004", avgPx: "100100", oid: 1 } }]).exchange);
    const request = { cloid: CLOID, side: "buy" as const, size8: 1_000_000n, limitPx8: 100_200n * BTC, reduceOnly: false };
    expect((await partial.placeIoc(request)).outcome).toBe("partial");

    const rejected = await connect(fakeInfo(), fakeExchange([{ error: "Insufficient margin to place order." }]).exchange);
    expect(await rejected.placeIoc(request)).toMatchObject({ outcome: "rejected", filled8: 0n });

    const noMatch = await connect(
      fakeInfo(),
      fakeExchange([{ error: "Order could not immediately match against any resting orders." }]).exchange,
    );
    expect((await noMatch.placeIoc(request)).outcome).toBe("unfilled");
  });

  it("throws on an unexpected status so the controller reconciles instead of assuming", async () => {
    const venue = await connect(fakeInfo(), fakeExchange([{ resting: { oid: 3 } }]).exchange);
    await expect(
      venue.placeIoc({ cloid: CLOID, side: "buy", size8: 1_000_000n, limitPx8: 100_200n * BTC, reduceOnly: false }),
    ).rejects.toThrow(/unexpected order status/);
  });

  it("refuses malformed sizes and prices before sending", async () => {
    const { exchange, orders } = fakeExchange([]);
    const venue = await connect(fakeInfo(), exchange);
    const base = { cloid: CLOID, side: "buy" as const, reduceOnly: false };
    await expect(venue.placeIoc({ ...base, size8: 1_000_001n, limitPx8: 100_000n * BTC })).rejects.toThrow(/szDecimals/);
    await expect(venue.placeIoc({ ...base, size8: 1_000_000n, limitPx8: 100_000n * BTC + 50_000_000n })).rejects.toThrow(/tick/);
    expect(orders).toHaveLength(0);
  });

  it("cannot trade without an agent key", async () => {
    const venue = await connect(fakeInfo(), null);
    await expect(
      venue.placeIoc({ cloid: CLOID, side: "buy", size8: 1_000_000n, limitPx8: 100_000n * BTC, reduceOnly: false }),
    ).rejects.toThrow(/read-only/);
  });

  it("cancels by cloid and surfaces a cancel error", async () => {
    const { exchange, cancels } = fakeExchange([]);
    const venue = await connect(fakeInfo(), exchange);
    await venue.cancelByCloid(CLOID);
    expect(cancels[0]).toEqual({ cancels: [{ asset: 1, cloid: CLOID }] });

    const failing: HlExchangeLike = {
      order: exchange.order,
      cancelByCloid: async () => ({ response: { data: { statuses: [{ error: "Order was never placed" }] } } }),
    };
    await expect((await connect(fakeInfo(), failing)).cancelByCloid(CLOID)).rejects.toThrow(/cancel failed/);
  });
});
