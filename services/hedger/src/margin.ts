import { keccak256, toBytes } from "viem";
import type { TopUpIntent } from "@noirwire/shared";
import { BPS, max, min, notionalUsd6 } from "./numbers.ts";
import type { AccountState } from "./types.ts";

const MARGIN_LOW_BPS = 20_000;
const MARGIN_URGENT_BPS = 13_000;
const SURPLUS_BPS = 40_000;
const RESTORE_RATIO_BPS = 30_000n;
const LEVERAGE_PRECISION = 1000;
const MS_PER_HOUR = 3_600_000;

export type MarginBand = "ok" | "low" | "urgent" | "surplus";

export function marginRatioBps(account: AccountState): number | null {
  if (account.totalMarginUsed6 <= 0n) return null;
  return Number((account.accountValue6 * BPS) / account.totalMarginUsed6);
}

export function classifyMargin(ratioBps: number | null): MarginBand {
  if (ratioBps === null) return "ok";
  if (ratioBps < MARGIN_URGENT_BPS) return "urgent";
  if (ratioBps < MARGIN_LOW_BPS) return "low";
  if (ratioBps > SURPLUS_BPS) return "surplus";
  return "ok";
}

function targetAccountValue6(account: AccountState, position8: bigint, leverageTarget: number): bigint {
  const notional = notionalUsd6(position8, account.markPx8);
  const byLeverage = (notional * BigInt(LEVERAGE_PRECISION)) / BigInt(Math.round(leverageTarget * LEVERAGE_PRECISION));
  const byRatio = (account.totalMarginUsed6 * RESTORE_RATIO_BPS) / BPS;
  return max(byLeverage, byRatio);
}

export function buildTopUpIntent(
  account: AccountState,
  position8: bigint,
  leverageTarget: number,
  nowMs: number,
): TopUpIntent | null {
  const ratio = marginRatioBps(account);
  const band = classifyMargin(ratio);
  if (band === "ok" || ratio === null) return null;
  const target = targetAccountValue6(account, position8, leverageTarget);
  const closeId = Math.floor(nowMs / MS_PER_HOUR);

  if (band === "surplus") {
    const surplus = min(account.withdrawable6, account.accountValue6 - target);
    if (surplus <= 0n) return null;
    return makeIntent("surplus-return", "hypercore-arc", surplus, ratio, closeId);
  }
  const shortfall = target - account.accountValue6;
  if (shortfall <= 0n) return null;
  return makeIntent(band === "urgent" ? "margin-urgent" : "margin-low", "arc-hypercore", shortfall, ratio, closeId);
}

function makeIntent(
  reason: TopUpIntent["reason"],
  route: TopUpIntent["route"],
  amount: bigint,
  ratio: number,
  closeId: number,
): TopUpIntent {
  const intentId = keccak256(toBytes(`${reason}:${route}:${closeId}:${amount}`));
  return { intentId, closeId, route, amount: amount.toString(), reason, marginRatioBps: ratio };
}
