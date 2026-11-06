import type { MakerFill } from "@noirwire/shared";
import type { JournalOrder } from "./journal.ts";
import type { AccountState } from "./types.ts";

const RECENT_ORDER_WINDOW_MS = 60_000;

export interface VenueRead {
  pos8: bigint;
  account: AccountState;
  at: number;
}

export interface PositionExpectation {
  expected8: bigint;
  positionBefore8: bigint;
  staleReads: number;
}

export interface ResolvedPosition {
  pos8: bigint;
  confirmed: boolean;
}

export function signedFillSize(fill: MakerFill): bigint {
  const size = BigInt(fill.size);
  return fill.makerSide === "buy" ? size : -size;
}

export function resolvePosition(
  venueRead: VenueRead | null,
  fallbackPos8: bigint,
  expectation: PositionExpectation | null,
  staleReadTolerance: number,
): { position: ResolvedPosition; expectation: PositionExpectation | null } {
  if (!venueRead) return { position: { pos8: fallbackPos8, confirmed: false }, expectation };
  const confirmed = { pos8: venueRead.pos8, confirmed: true };
  if (!expectation) return { position: confirmed, expectation: null };
  if (venueRead.pos8 === expectation.expected8) return { position: confirmed, expectation: null };
  if (venueRead.pos8 === expectation.positionBefore8 && expectation.staleReads < staleReadTolerance) {
    return {
      position: { pos8: expectation.expected8, confirmed: false },
      expectation: { ...expectation, staleReads: expectation.staleReads + 1 },
    };
  }
  return { position: confirmed, expectation: null };
}

export function expectationAfterFill(order: JournalOrder, now: number): PositionExpectation | null {
  if (order.filled8 <= 0n || now - order.intentAt >= RECENT_ORDER_WINDOW_MS) return null;
  const signed = order.side === "buy" ? order.filled8 : -order.filled8;
  return {
    positionBefore8: order.positionBefore8,
    expected8: order.positionBefore8 + signed,
    staleReads: 0,
  };
}
