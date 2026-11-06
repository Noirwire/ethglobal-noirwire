import { BTC_DECIMALS, USDC_DECIMALS } from "@noirwire/shared";

export const PRICE_DECIMALS = 8;
export const BPS_DENOMINATOR = 10_000n;
export const ONE_BTC = 10n ** BigInt(BTC_DECIMALS);
export const USDC_PER_BTC_TO_PRICE_E8 = 10n ** BigInt(BTC_DECIMALS + PRICE_DECIMALS - USDC_DECIMALS);

export const Direction = {
  None: 0,
  MakerSellsBtc: 1,
  MakerBuysBtc: 2,
} as const;
export type DirectionCode = (typeof Direction)[keyof typeof Direction];

export function toDirectionCode(value: number): DirectionCode {
  const code = Object.values(Direction).find((candidate) => candidate === value);
  if (code === undefined) throw new Error(`unknown hedge direction ${value}`);
  return code;
}

export interface HedgeTarget {
  direction: DirectionCode;
  remaining: bigint;
  minPriceE8: bigint;
  maxPriceE8: bigint;
  expiry: bigint;
}

export interface OracleReading {
  answer: bigint;
  decimals: number;
  updatedAt: bigint;
  maxAge: bigint;
  maxDeviationBps: bigint;
}

export interface FillRequest {
  target: HedgeTarget;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  now: bigint;
  oracle: OracleReading;
  wbtc: string;
  usdc: string;
}

export type GuardReason =
  | "AmountsNotComputed"
  | "TargetNotSet"
  | "TargetExpired"
  | "WrongDirection"
  | "SizeExceedsRemaining"
  | "PriceOutsideBand"
  | "OracleInvalid"
  | "OracleStale"
  | "PriceFarFromOracle";

export type FillCheck =
  | { ok: true; btc8: bigint; priceE8: bigint }
  | { ok: false; reason: GuardReason };

export function impliedPriceE8(usdc6: bigint, btc8: bigint): bigint {
  return (usdc6 * USDC_PER_BTC_TO_PRICE_E8) / btc8;
}

export function usdcForBtc(btc8: bigint, priceE8: bigint, rounding: "up" | "down"): bigint {
  const product = btc8 * priceE8;
  if (rounding === "down") return product / USDC_PER_BTC_TO_PRICE_E8;
  return (product + USDC_PER_BTC_TO_PRICE_E8 - 1n) / USDC_PER_BTC_TO_PRICE_E8;
}

export function scaleFeedAnswerToE8(answer: bigint, decimals: number): bigint {
  if (decimals > PRICE_DECIMALS) return answer / 10n ** BigInt(decimals - PRICE_DECIMALS);
  if (decimals < PRICE_DECIMALS) return answer * 10n ** BigInt(PRICE_DECIMALS - decimals);
  return answer;
}

export function bandAround(oracleE8: bigint, halfWidthBps: bigint): { minPriceE8: bigint; maxPriceE8: bigint } {
  return {
    minPriceE8: (oracleE8 * (BPS_DENOMINATOR - halfWidthBps)) / BPS_DENOMINATOR,
    maxPriceE8: (oracleE8 * (BPS_DENOMINATOR + halfWidthBps)) / BPS_DENOMINATOR,
  };
}

export function allowedTokens<T extends string>(
  direction: DirectionCode,
  wbtc: T,
  usdc: T,
): { tokenIn: T; tokenOut: T } | undefined {
  if (direction === Direction.MakerSellsBtc) return { tokenIn: usdc, tokenOut: wbtc };
  if (direction === Direction.MakerBuysBtc) return { tokenIn: wbtc, tokenOut: usdc };
  return undefined;
}

export function xycAmountOut(balanceIn: bigint, balanceOut: bigint, amountIn: bigint): bigint {
  return (amountIn * balanceOut) / (balanceIn + amountIn);
}

export function xycAmountIn(balanceIn: bigint, balanceOut: bigint, amountOut: bigint): bigint {
  const numerator = amountOut * balanceIn;
  const denominator = balanceOut - amountOut;
  return (numerator + denominator - 1n) / denominator;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function checkFill(request: FillRequest): FillCheck {
  const { target, oracle } = request;
  if (request.amountIn === 0n || request.amountOut === 0n) return { ok: false, reason: "AmountsNotComputed" };
  if (target.direction === Direction.None) return { ok: false, reason: "TargetNotSet" };
  if (request.now > target.expiry) return { ok: false, reason: "TargetExpired" };

  const allowed = allowedTokens(target.direction, request.wbtc, request.usdc);
  if (
    allowed === undefined ||
    !sameAddress(request.tokenIn, allowed.tokenIn) ||
    !sameAddress(request.tokenOut, allowed.tokenOut)
  ) {
    return { ok: false, reason: "WrongDirection" };
  }

  const sells = target.direction === Direction.MakerSellsBtc;
  const btc8 = sells ? request.amountOut : request.amountIn;
  const usdc6 = sells ? request.amountIn : request.amountOut;
  if (btc8 > target.remaining) return { ok: false, reason: "SizeExceedsRemaining" };

  const priceE8 = impliedPriceE8(usdc6, btc8);
  if (priceE8 < target.minPriceE8 || priceE8 > target.maxPriceE8) return { ok: false, reason: "PriceOutsideBand" };

  if (oracle.answer <= 0n) return { ok: false, reason: "OracleInvalid" };
  if (oracle.updatedAt === 0n || request.now > oracle.updatedAt + oracle.maxAge) {
    return { ok: false, reason: "OracleStale" };
  }
  const oracleE8 = scaleFeedAnswerToE8(oracle.answer, oracle.decimals);
  if (oracleE8 === 0n) return { ok: false, reason: "OracleInvalid" };

  const diff = priceE8 > oracleE8 ? priceE8 - oracleE8 : oracleE8 - priceE8;
  if (diff * BPS_DENOMINATOR > oracleE8 * oracle.maxDeviationBps) return { ok: false, reason: "PriceFarFromOracle" };

  return { ok: true, btc8, priceE8 };
}
