import { btcToDecimal, notionalUsd6 } from "./numbers.ts";
import { classifyMargin, marginRatioBps, type MarginBand } from "./margin.ts";
import { makerQuotePolicy, type QuotePolicy } from "./policy.ts";
import type { VenueRead } from "./position.ts";
import type { HedgeStatus, ReferencePrice } from "./types.ts";

export interface StatusSnapshot {
  status: HedgeStatus;
  quotePolicy: QuotePolicy;
  decision: string;
  hedgeEnabled: boolean;
  market: string;
  makerPosition: string;
  hyperliquidPosition: string;
  aquaInventory: string;
  netResidual: string;
  unhedgedNotionalUsd6: string;
  referenceExpired: boolean;
  unresolvedOrders: number;
  awaitingPositionConfirmation: boolean;
  marginRatioBps: number | null;
  marginBand: MarginBand;
  lastVenueReadAt: string | null;
  lastConfirmedAt: string | null;
  updatedAt: string;
}

export interface Unhedged {
  notional6: bigint;
  referenceExpired: boolean;
}

export interface StatusLimits {
  softLimitUsd6: bigint;
  hardLimitUsd6: bigint;
  referenceMaxAgeMs: number;
  confirmMaxAgeMs: number;
  blindAfterMs: number;
}

export interface StatusClocks {
  lastVenueReadAt: number | null;
  lastFillPollOkAt: number | null;
  lastConfirmedAt: number | null;
}

export function netExposure8(makerPos8: bigint, venuePos8: bigint, aqua8: bigint): bigint {
  return makerPos8 + venuePos8 + aqua8;
}

export function assessExposure(
  net8: bigint,
  reference: ReferencePrice | null,
  now: number,
  limits: Pick<StatusLimits, "hardLimitUsd6" | "referenceMaxAgeMs">,
): Unhedged {
  if (!reference || now - reference.at > limits.referenceMaxAgeMs) {
    return { notional6: limits.hardLimitUsd6, referenceExpired: true };
  }
  return { notional6: notionalUsd6(net8, reference.px8), referenceExpired: false };
}

export function isConfirmable(unhedged: Unhedged, fresh: boolean, noUnresolved: boolean, softLimitUsd6: bigint): boolean {
  return fresh && !unhedged.referenceExpired && noUnresolved && unhedged.notional6 < softLimitUsd6;
}

export function computeStatus(
  now: number,
  unhedged: Unhedged,
  clocks: StatusClocks,
  limits: StatusLimits,
  manualHalt: string | null,
): HedgeStatus {
  if (manualHalt) return "halted";
  const venueBlind = clocks.lastVenueReadAt === null || now - clocks.lastVenueReadAt > limits.blindAfterMs;
  const fillBlind = clocks.lastFillPollOkAt === null || now - clocks.lastFillPollOkAt > limits.blindAfterMs;
  if (venueBlind || fillBlind) return "blind";
  if (unhedged.notional6 >= limits.hardLimitUsd6) return "halted";
  if (clocks.lastConfirmedAt !== null && now - clocks.lastConfirmedAt <= limits.confirmMaxAgeMs) return "hedged";
  return "lagging";
}

export interface SnapshotInput {
  status: HedgeStatus;
  decision: string;
  hedgeEnabled: boolean;
  market: string;
  makerPos8: bigint;
  position8: bigint;
  aqua8: bigint;
  unhedged: Unhedged;
  unresolvedOrders: number;
  awaitingPositionConfirmation: boolean;
  lastVenue: VenueRead | null;
  lastConfirmedAt: number | null;
  now: number;
}

export function buildSnapshot(input: SnapshotInput): StatusSnapshot {
  const ratio = input.lastVenue ? marginRatioBps(input.lastVenue.account) : null;
  return {
    status: input.status,
    quotePolicy: makerQuotePolicy(input.status, input.makerPos8),
    decision: input.decision,
    hedgeEnabled: input.hedgeEnabled,
    market: input.market,
    makerPosition: btcToDecimal(input.makerPos8),
    hyperliquidPosition: btcToDecimal(input.position8),
    aquaInventory: btcToDecimal(input.aqua8),
    netResidual: btcToDecimal(netExposure8(input.makerPos8, input.position8, input.aqua8)),
    unhedgedNotionalUsd6: input.unhedged.notional6.toString(),
    referenceExpired: input.unhedged.referenceExpired,
    unresolvedOrders: input.unresolvedOrders,
    awaitingPositionConfirmation: input.awaitingPositionConfirmation,
    marginRatioBps: ratio,
    marginBand: classifyMargin(ratio),
    lastVenueReadAt: input.lastVenue ? new Date(input.lastVenue.at).toISOString() : null,
    lastConfirmedAt: input.lastConfirmedAt === null ? null : new Date(input.lastConfirmedAt).toISOString(),
    updatedAt: new Date(input.now).toISOString(),
  };
}

export function initialSnapshot(market: string, hedgeEnabled: boolean, initialMakerPos8: bigint): StatusSnapshot {
  return {
    status: "blind",
    quotePolicy: makerQuotePolicy("blind", initialMakerPos8),
    decision: "starting",
    hedgeEnabled,
    market,
    makerPosition: btcToDecimal(initialMakerPos8),
    hyperliquidPosition: "0",
    aquaInventory: "0",
    netResidual: "0",
    unhedgedNotionalUsd6: "0",
    referenceExpired: true,
    unresolvedOrders: 0,
    awaitingPositionConfirmation: false,
    marginRatioBps: null,
    marginBand: "ok",
    lastVenueReadAt: null,
    lastConfirmedAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}
