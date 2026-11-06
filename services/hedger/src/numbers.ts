import { fromBaseUnits, toBaseUnits } from "@noirwire/shared";

export const BTC_UNIT = 100_000_000n;
export const PRICE_DECIMALS = 8;
export const USD_DECIMALS = 6;
export const BPS = 10_000n;

export function parseDecimalTruncating(value: string, decimals: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  return negative ? -units : units;
}

export function btcFromDecimal(value: string): bigint {
  return parseDecimalTruncating(value, 8);
}

export function priceFromDecimal(value: string): bigint {
  return parseDecimalTruncating(value, PRICE_DECIMALS);
}

export function usdFromDecimal(value: string): bigint {
  return parseDecimalTruncating(value, USD_DECIMALS);
}

export function btcToDecimal(units: bigint): string {
  return fromBaseUnits(units, 8);
}

export function priceToDecimal(px8: bigint): string {
  return fromBaseUnits(px8, PRICE_DECIMALS);
}

export function strictBtc(decimal: string): bigint {
  return toBaseUnits(decimal, 8);
}

export function strictPrice(decimal: string): bigint {
  return toBaseUnits(decimal, PRICE_DECIMALS);
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function notionalUsd6(size8: bigint, px8: bigint): bigint {
  return (abs(size8) * px8) / 10_000_000_000n;
}

export function sizeForNotionalCeil(notionalUsd6Value: bigint, px8: bigint): bigint {
  if (px8 <= 0n) throw new Error("price must be positive");
  const numerator = notionalUsd6Value * 10_000_000_000n;
  return (numerator + px8 - 1n) / px8;
}
