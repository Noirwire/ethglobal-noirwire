import { describe, expect, it } from "vitest";
import {
  allowedPriceDecimals,
  isValidPerpPrice,
  isValidSize,
  minOrderSize,
  roundPriceForSide,
  roundSizeDown,
  roundSizeUp,
} from "../src/hl-rules.ts";
import {
  btcFromDecimal,
  btcToDecimal,
  notionalUsd6,
  parseDecimalTruncating,
  priceFromDecimal,
  priceToDecimal,
} from "../src/numbers.ts";

const SZ = 5;

describe("Hyperliquid BTC price rounding", () => {
  it("rounds buys up and sells down to a whole dollar at BTC magnitudes", () => {
    const px = priceFromDecimal("100123.45");
    expect(priceToDecimal(roundPriceForSide(px, "buy", SZ))).toBe("100124");
    expect(priceToDecimal(roundPriceForSide(px, "sell", SZ))).toBe("100123");
  });

  it("leaves already valid prices untouched", () => {
    const px = priceFromDecimal("98765");
    expect(roundPriceForSide(px, "buy", SZ)).toBe(px);
    expect(roundPriceForSide(px, "sell", SZ)).toBe(px);
  });

  it("allows one decimal when the integer part has four digits and none from five", () => {
    expect(allowedPriceDecimals(priceFromDecimal("9999.55"), SZ)).toBe(1);
    expect(allowedPriceDecimals(priceFromDecimal("99999.5"), SZ)).toBe(0);
    expect(priceToDecimal(roundPriceForSide(priceFromDecimal("9999.55"), "buy", SZ))).toBe("9999.6");
    expect(priceToDecimal(roundPriceForSide(priceFromDecimal("9999.55"), "sell", SZ))).toBe("9999.5");
  });

  it("caps decimals at six minus szDecimals and at five significant figures", () => {
    expect(priceToDecimal(roundPriceForSide(priceFromDecimal("1.234567"), "buy", 2))).toBe("1.2346");
    expect(priceToDecimal(roundPriceForSide(priceFromDecimal("1.234567"), "sell", 2))).toBe("1.2345");
    expect(priceToDecimal(roundPriceForSide(priceFromDecimal("0.0123456"), "sell", 0))).toBe("0.012345");
  });

  it("recognizes valid and invalid perp prices", () => {
    expect(isValidPerpPrice(priceFromDecimal("100000"), SZ)).toBe(true);
    expect(isValidPerpPrice(priceFromDecimal("123456"), SZ)).toBe(true);
    expect(isValidPerpPrice(priceFromDecimal("99999.5"), SZ)).toBe(false);
    expect(isValidPerpPrice(priceFromDecimal("9999.55"), SZ)).toBe(false);
    expect(isValidPerpPrice(priceFromDecimal("9999.5"), SZ)).toBe(true);
    expect(isValidPerpPrice(0n, SZ)).toBe(false);
  });
});

describe("size rounding to szDecimals", () => {
  it("rounds down and up to five decimals for BTC", () => {
    expect(roundSizeDown(12_345_678n, SZ)).toBe(12_345_000n);
    expect(roundSizeUp(12_345_678n, SZ)).toBe(12_346_000n);
    expect(roundSizeDown(999n, SZ)).toBe(0n);
    expect(roundSizeUp(12_345_000n, SZ)).toBe(12_345_000n);
  });

  it("validates sizes against szDecimals", () => {
    expect(isValidSize(12_345_000n, SZ)).toBe(true);
    expect(isValidSize(12_345_001n, SZ)).toBe(false);
    expect(isValidSize(0n, SZ)).toBe(false);
  });

  it("derives the venue minimum size from the minimum notional", () => {
    const px = priceFromDecimal("100000");
    expect(minOrderSize(px, SZ, 10_000_000n)).toBe(10_000n);
    expect(minOrderSize(px, SZ, 11_000_000n)).toBe(11_000n);
    expect(minOrderSize(priceFromDecimal("1000000"), SZ, 5_000n)).toBe(1_000n);
  });
});

describe("bigint unit conversion", () => {
  it("converts decimals to base units without floats", () => {
    expect(btcFromDecimal("0.12345678")).toBe(12_345_678n);
    expect(btcFromDecimal("-1.5")).toBe(-150_000_000n);
    expect(btcFromDecimal("0.123456789")).toBe(12_345_678n);
    expect(parseDecimalTruncating("12.3456789", 6)).toBe(12_345_678n);
  });

  it("round trips through decimal strings", () => {
    for (const units of [0n, 1n, 12_345_678n, -99_999_999n, 1_234_567_890_123n]) {
      expect(btcFromDecimal(btcToDecimal(units))).toBe(units);
    }
  });

  it("computes notional in usd 6dp", () => {
    expect(notionalUsd6(100_000_000n, priceFromDecimal("100000"))).toBe(100_000_000_000n);
    expect(notionalUsd6(-50_000_000n, priceFromDecimal("100000"))).toBe(50_000_000_000n);
  });
});
