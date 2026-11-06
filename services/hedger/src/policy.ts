import type { HedgeStatus } from "./types.ts";

export type QuoteMode = "normal" | "thin" | "reduce-only" | "stop";

export interface QuotePolicy {
  mode: QuoteMode;
  sizeFactorBps: number;
  reason: string;
}

const THIN_SIZE_FACTOR_BPS = 2_500;
const FULL_SIZE_FACTOR_BPS = 10_000;

export function makerQuotePolicy(status: HedgeStatus, makerPosition: bigint): QuotePolicy {
  const flat = makerPosition === 0n;
  switch (status) {
    case "hedged":
      return { mode: "normal", sizeFactorBps: FULL_SIZE_FACTOR_BPS, reason: "hedge confirmed" };
    case "lagging":
      return { mode: "thin", sizeFactorBps: THIN_SIZE_FACTOR_BPS, reason: "hedge is behind: quote smaller" };
    case "blind":
      return flat
        ? { mode: "thin", sizeFactorBps: THIN_SIZE_FACTOR_BPS, reason: "flat and blind: quote normally but thin" }
        : { mode: "reduce-only", sizeFactorBps: FULL_SIZE_FACTOR_BPS, reason: "positioned and blind: only quotes that reduce the position" };
    case "halted":
      return flat
        ? { mode: "stop", sizeFactorBps: 0, reason: "halted and flat: no quotes" }
        : { mode: "reduce-only", sizeFactorBps: FULL_SIZE_FACTOR_BPS, reason: "halted with a position: only quotes that reduce it" };
  }
}
