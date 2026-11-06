import { BTC_DECIMALS, fromBaseUnits, parseDecimalTruncating, USDC_DECIMALS } from "@noirwire/shared";

export { parseDecimalTruncating };

export const PRICE_DECIMALS = 8;
export const BPS = 10_000n;
export const BPS_NUMBER = Number(BPS);
export const SIZE_TIMES_PRICE_PER_USD6 = 10n ** BigInt(BTC_DECIMALS + PRICE_DECIMALS - USDC_DECIMALS);

export function btcFromDecimal(value: string): bigint {
  return parseDecimalTruncating(value, BTC_DECIMALS);
}

export function priceFromDecimal(value: string): bigint {
  return parseDecimalTruncating(value, PRICE_DECIMALS);
}

export function usdFromDecimal(value: string): bigint {
  return parseDecimalTruncating(value, USDC_DECIMALS);
}

export function btcToDecimal(units: bigint): string {
  return fromBaseUnits(units, BTC_DECIMALS);
}

export function priceToDecimal(px8: bigint): string {
  return fromBaseUnits(px8, PRICE_DECIMALS);
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
  return (abs(size8) * px8) / SIZE_TIMES_PRICE_PER_USD6;
}

export function sizeForNotionalCeil(notionalUsd6Value: bigint, px8: bigint): bigint {
  if (px8 <= 0n) throw new Error("price must be positive");
  const numerator = notionalUsd6Value * SIZE_TIMES_PRICE_PER_USD6;
  return (numerator + px8 - 1n) / px8;
}
