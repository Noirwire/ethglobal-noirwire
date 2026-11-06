import { describe, expect, it } from "vitest";
import {
  Direction,
  type FillRequest,
  allowedTokens,
  bandAround,
  checkFill,
  impliedPriceE8,
  scaleFeedAnswerToE8,
  usdcForBtc,
  xycAmountIn,
  xycAmountOut,
} from "../src/band.ts";

const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const NOW = 1_000_000n;
const ORACLE_E8 = 7_500_000_000_000n;

function request(overrides: Partial<FillRequest> = {}): FillRequest {
  const priceE8 = ORACLE_E8;
  const btc8 = 1_000_000n;
  return {
    target: {
      direction: Direction.MakerSellsBtc,
      remaining: 50_000_000n,
      minPriceE8: (ORACLE_E8 * 95n) / 100n,
      maxPriceE8: (ORACLE_E8 * 105n) / 100n,
      expiry: NOW + 3600n,
    },
    tokenIn: USDC,
    tokenOut: WBTC,
    amountIn: usdcForBtc(btc8, priceE8, "up"),
    amountOut: btc8,
    now: NOW,
    oracle: { answer: ORACLE_E8, decimals: 8, updatedAt: NOW - 60n, maxAge: 3600n, maxDeviationBps: 300n },
    wbtc: WBTC,
    usdc: USDC,
    ...overrides,
  };
}

describe("price math", () => {
  it("derives an 8 decimal USD price from 6 decimal USDC and 8 decimal BTC", () => {
    expect(impliedPriceE8(75_000_000_000n, 100_000_000n)).toBe(ORACLE_E8);
    expect(impliedPriceE8(756_305_161n, 990_099n)).toBe(76_386_822_024_86n);
  });

  it("rounds USDC up when the maker is paid and down when the maker pays", () => {
    expect(usdcForBtc(1n, 10_000_000_001n, "up")).toBe(2n);
    expect(usdcForBtc(1n, 10_000_000_001n, "down")).toBe(1n);
    expect(usdcForBtc(100_000_000n, ORACLE_E8, "up")).toBe(75_000_000_000n);
  });

  it("scales feed answers of any decimals to 8", () => {
    expect(scaleFeedAnswerToE8(ORACLE_E8, 8)).toBe(ORACLE_E8);
    expect(scaleFeedAnswerToE8(ORACLE_E8 * 10n ** 10n, 18)).toBe(ORACLE_E8);
    expect(scaleFeedAnswerToE8(75_000n * 10n ** 2n, 2)).toBe(7_500_000_000_000n / 10n ** 6n * 10n ** 6n);
    expect(scaleFeedAnswerToE8(75_000n, 0)).toBe(7_500_000_000_000n);
  });

  it("builds a symmetric band around the oracle", () => {
    expect(bandAround(10_000n, 500n)).toEqual({ minPriceE8: 9_500n, maxPriceE8: 10_500n });
  });

  it("matches the constant product formula with floor on out and ceiling on in", () => {
    expect(xycAmountOut(100n, 100n, 10n)).toBe(9n);
    expect(xycAmountIn(100n, 100n, 9n)).toBe(10n);
    for (const [bin, bout, amountIn] of [[1_000n, 5_000n, 7n], [10n ** 12n, 10n ** 10n, 10n ** 9n]] as const) {
      const out = xycAmountOut(bin, bout, amountIn);
      expect(xycAmountIn(bin, bout, out)).toBeLessThanOrEqual(amountIn);
    }
  });

  it("maps each direction to exactly one token pair", () => {
    expect(allowedTokens(Direction.MakerSellsBtc, WBTC, USDC)).toEqual({ tokenIn: USDC, tokenOut: WBTC });
    expect(allowedTokens(Direction.MakerBuysBtc, WBTC, USDC)).toEqual({ tokenIn: WBTC, tokenOut: USDC });
    expect(allowedTokens(Direction.None, WBTC, USDC)).toBeUndefined();
  });
});

describe("checkFill mirrors the on-chain guard", () => {
  it("accepts an in-band fill in the allowed direction", () => {
    const result = checkFill(request());
    expect(result).toEqual({ ok: true, btc8: 1_000_000n, priceE8: ORACLE_E8 });
  });

  it("accepts the mirrored buy-side fill", () => {
    const btc8 = 2_000_000n;
    const result = checkFill(
      request({
        target: { ...request().target, direction: Direction.MakerBuysBtc },
        tokenIn: WBTC,
        tokenOut: USDC,
        amountIn: btc8,
        amountOut: usdcForBtc(btc8, ORACLE_E8, "down"),
      }),
    );
    expect(result).toMatchObject({ ok: true, btc8 });
  });

  const rejections: Array<[string, Partial<FillRequest>, string]> = [
    ["zero amount in", { amountIn: 0n }, "AmountsNotComputed"],
    ["zero amount out", { amountOut: 0n }, "AmountsNotComputed"],
    ["no target", { target: { ...request().target, direction: Direction.None } }, "TargetNotSet"],
    ["expired target", { now: NOW + 3601n, oracle: { ...request().oracle, updatedAt: NOW + 3600n } }, "TargetExpired"],
    ["reversed pair", { tokenIn: WBTC, tokenOut: USDC }, "WrongDirection"],
    ["unrelated token", { tokenIn: USDC, tokenOut: USDC }, "WrongDirection"],
    ["overfill", { amountOut: 50_000_001n, amountIn: usdcForBtc(50_000_001n, ORACLE_E8, "up") }, "SizeExceedsRemaining"],
    ["price below band", { amountIn: usdcForBtc(1_000_000n, (ORACLE_E8 * 90n) / 100n, "up") }, "PriceOutsideBand"],
    ["price above band", { amountIn: usdcForBtc(1_000_000n, (ORACLE_E8 * 110n) / 100n, "up") }, "PriceOutsideBand"],
    ["non positive feed", { oracle: { ...request().oracle, answer: 0n } }, "OracleInvalid"],
    ["stale feed", { oracle: { ...request().oracle, updatedAt: NOW - 3601n } }, "OracleStale"],
    [
      "price far from a moved feed",
      { oracle: { ...request().oracle, answer: (ORACLE_E8 * 104n) / 100n } },
      "PriceFarFromOracle",
    ],
  ];

  it.each(rejections)("rejects %s", (_name, overrides, reason) => {
    expect(checkFill(request(overrides))).toEqual({ ok: false, reason });
  });

  it("treats a feed exactly at max age as fresh and one second older as stale", () => {
    expect(checkFill(request({ oracle: { ...request().oracle, updatedAt: NOW - 3600n } })).ok).toBe(true);
    expect(checkFill(request({ oracle: { ...request().oracle, updatedAt: NOW - 3601n } })).ok).toBe(false);
  });

  it("compares token addresses case-insensitively", () => {
    expect(checkFill(request({ tokenIn: USDC.toLowerCase(), tokenOut: WBTC.toLowerCase() })).ok).toBe(true);
  });

  it("scales a high-decimal feed before comparing", () => {
    const oracle = { ...request().oracle, answer: ORACLE_E8 * 10n ** 10n, decimals: 18 };
    expect(checkFill(request({ oracle })).ok).toBe(true);
  });
});
