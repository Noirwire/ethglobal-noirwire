import { BTC_DECIMALS } from "@noirwire/shared";
import { max, notionalUsd6, PRICE_DECIMALS, sizeForNotionalCeil } from "./numbers.ts";
import type { Side } from "./types.ts";

const PERP_MAX_DECIMALS = 6;
const MAX_SIGNIFICANT_FIGURES = 5;

function sizeUnit(szDecimals: number): bigint {
  return 10n ** BigInt(BTC_DECIMALS - szDecimals);
}

export function roundSizeDown(size8: bigint, szDecimals: number): bigint {
  const unit = sizeUnit(szDecimals);
  return (size8 / unit) * unit;
}

export function roundSizeUp(size8: bigint, szDecimals: number): bigint {
  const unit = sizeUnit(szDecimals);
  return ((size8 + unit - 1n) / unit) * unit;
}

export function minOrderSize(limitPx8: bigint, szDecimals: number, minNotional6: bigint): bigint {
  const bySize = sizeUnit(szDecimals);
  const byNotional = roundSizeUp(sizeForNotionalCeil(minNotional6, limitPx8), szDecimals);
  return max(byNotional, bySize);
}

export function allowedPriceDecimals(px8: bigint, szDecimals: number): number {
  const scale = 10n ** BigInt(PRICE_DECIMALS);
  const whole = px8 / scale;
  const byDecimals = PERP_MAX_DECIMALS - szDecimals;
  if (whole > 0n) {
    const integerDigits = whole.toString().length;
    return Math.max(0, Math.min(byDecimals, MAX_SIGNIFICANT_FIGURES - integerDigits));
  }
  const fraction = px8.toString().padStart(PRICE_DECIMALS, "0");
  const leadingZeros = fraction.length - fraction.replace(/^0+/, "").length;
  return Math.max(0, Math.min(byDecimals, leadingZeros + MAX_SIGNIFICANT_FIGURES));
}

export function roundPriceForSide(px8: bigint, side: Side, szDecimals: number): bigint {
  const decimals = allowedPriceDecimals(px8, szDecimals);
  const unit = 10n ** BigInt(PRICE_DECIMALS - decimals);
  const floor = (px8 / unit) * unit;
  if (floor === px8) return px8;
  return side === "buy" ? floor + unit : floor;
}

export function isValidPerpPrice(px8: bigint, szDecimals: number): boolean {
  if (px8 <= 0n) return false;
  const scale = 10n ** BigInt(PRICE_DECIMALS);
  if (px8 % scale === 0n) return true;
  const decimals = allowedPriceDecimals(px8, szDecimals);
  const unit = 10n ** BigInt(PRICE_DECIMALS - decimals);
  if (px8 % unit !== 0n) return false;
  const digits = (px8 / unit).toString().length;
  return digits <= MAX_SIGNIFICANT_FIGURES;
}

export function isValidSize(size8: bigint, szDecimals: number): boolean {
  return size8 > 0n && size8 % sizeUnit(szDecimals) === 0n;
}

export function meetsMinNotional(size8: bigint, limitPx8: bigint, minNotional6: bigint): boolean {
  return notionalUsd6(size8, limitPx8) >= minNotional6;
}
