import { minOrderSize, roundPriceForSide, roundSizeDown } from "./hl-rules.ts";
import { abs, BPS, BPS_NUMBER, max, min, notionalUsd6, SIZE_TIMES_PRICE_PER_USD6 } from "./numbers.ts";
import { classifyMargin, marginRatioBps } from "./margin.ts";
import type { AccountState, AquaBand, Side, VenueSpec } from "./types.ts";

const MAX_HEDGE_LEVERAGE = 5n;
const SHRINK_FLOOR_BPS = 1_000;
export const FULL_FACTOR_BPS = BPS_NUMBER;

export function sideForDelta(delta8: bigint): Side {
  return delta8 > 0n ? "buy" : "sell";
}

export function holdThreshold8(deadband8: bigint, minSize8: bigint): bigint {
  return max(deadband8, minSize8);
}

function shiftByBps(px8: bigint, bps: number, direction: "up" | "down"): bigint {
  const band = BigInt(bps);
  return (px8 * (direction === "up" ? BPS + band : BPS - band)) / BPS;
}

export function limitPrice(markPx8: bigint, side: Side, priceBandBps: number, szDecimals: number): bigint | null {
  const raw = shiftByBps(markPx8, priceBandBps, side === "buy" ? "up" : "down");
  const inward = roundPriceForSide(raw, side === "buy" ? "sell" : "buy", szDecimals);
  const crosses = side === "buy" ? inward >= markPx8 : inward <= markPx8;
  return crosses ? inward : null;
}

export interface OrderBounds {
  side: Side;
  limitPx8: bigint;
  minSize: bigint;
}

export function orderBounds(
  delta8: bigint,
  markPx8: bigint,
  priceBandBps: number,
  spec: Pick<VenueSpec, "szDecimals" | "minNotional6">,
): OrderBounds | null {
  const side = sideForDelta(delta8);
  const limitPx8 = limitPrice(markPx8, side, priceBandBps, spec.szDecimals);
  if (limitPx8 === null) return null;
  return { side, limitPx8, minSize: minOrderSize(limitPx8, spec.szDecimals, spec.minNotional6) };
}

export function aquaBandFor(
  side: Side,
  remaining8: bigint,
  markPx8: bigint,
  priceBandBps: number,
  expiresAt: number,
): AquaBand {
  return {
    direction: side,
    maxSize8: remaining8,
    minPx8: shiftByBps(markPx8, priceBandBps, "down"),
    maxPx8: shiftByBps(markPx8, priceBandBps, "up"),
    expiresAt,
  };
}

export function reducingPortion(side: Side, size8: bigint, pos8: bigint): bigint {
  const opposes = (side === "buy" && pos8 < 0n) || (side === "sell" && pos8 > 0n);
  return opposes ? min(size8, abs(pos8)) : 0n;
}

export function isReduceOnly(side: Side, size8: bigint, pos8: bigint): boolean {
  return pos8 !== 0n && reducingPortion(side, size8, pos8) === size8;
}

function marginRoomSize8(pos8: bigint, account: AccountState): bigint {
  const maxNotional6 = account.accountValue6 * MAX_HEDGE_LEVERAGE;
  const current6 = notionalUsd6(pos8, account.markPx8);
  if (current6 >= maxNotional6) return 0n;
  return ((maxNotional6 - current6) * SIZE_TIMES_PRICE_PER_USD6) / account.markPx8;
}

export interface OrderSizingInput {
  wanted8: bigint;
  side: Side;
  pos8: bigint;
  account: AccountState;
  maxOrder8: bigint;
  urgentShrinkBps: number;
  rejectFactorBps: number;
  szDecimals: number;
}

export function sizeOrder(input: OrderSizingInput): bigint {
  const { wanted8, side, pos8, account } = input;
  const urgent = classifyMargin(marginRatioBps(account)) === "urgent";
  const marginFactor = urgent ? input.urgentShrinkBps : FULL_FACTOR_BPS;
  const shrink = Math.floor((marginFactor * input.rejectFactorBps) / FULL_FACTOR_BPS);
  const factor = BigInt(Math.max(SHRINK_FLOOR_BPS, shrink));
  const capped = min(wanted8, (input.maxOrder8 * factor) / BPS);
  const reducing = reducingPortion(side, capped, pos8);
  const increasing = capped - reducing;
  const allowed = reducing + min(increasing, marginRoomSize8(pos8, account));
  return roundSizeDown(allowed, input.szDecimals);
}

export interface Throttle {
  backoffMs: number;
  backoffUntil: number;
  rejectFactorBps: number;
}

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

export const INITIAL_THROTTLE: Throttle = { backoffMs: 0, backoffUntil: 0, rejectFactorBps: FULL_FACTOR_BPS };

export function throttleAfterPlacement(
  previous: Throttle,
  outcome: string,
  reason: string | undefined,
  now: number,
  policy: BackoffPolicy,
): Throttle {
  if (outcome === "filled" || outcome === "partial") {
    return { backoffMs: 0, backoffUntil: 0, rejectFactorBps: Math.min(FULL_FACTOR_BPS, previous.rejectFactorBps * 2) };
  }
  const backoffMs = previous.backoffMs === 0 ? policy.baseMs : Math.min(previous.backoffMs * 2, policy.maxMs);
  const marginRejected = reason !== undefined && /margin/i.test(reason);
  return {
    backoffMs,
    backoffUntil: now + backoffMs,
    rejectFactorBps: marginRejected
      ? Math.max(SHRINK_FLOOR_BPS, Math.floor(previous.rejectFactorBps / 2))
      : previous.rejectFactorBps,
  };
}
