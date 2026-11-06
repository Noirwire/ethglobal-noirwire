import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { oldestObservedAtSec, reasonCode, routeCode } from "./nav.ts";
import type { NavSnapshot, TopUpIntent } from "./shared.ts";

export const KIND_NAV = 1;
export const KIND_TOP_UP = 2;
export const REPORT_VERSION = 1;

const NAV_BODY = parseAbiParameters(
  "(uint8 version, uint64 closeId, uint64 observedAt, uint256 totalAssets, uint256 totalLiabilities, bytes32 sourcesHash) report",
);
const TOP_UP_BODY = parseAbiParameters(
  "(uint8 version, bytes32 intentId, uint64 closeId, uint8 route, uint256 amount, uint16 marginRatioBps, uint8 reason) intent",
);
const ENVELOPE = parseAbiParameters("uint8 kind, bytes body");

export function encodeNavBody(snapshot: NavSnapshot): Hex {
  return encodeAbiParameters(NAV_BODY, [
    {
      version: REPORT_VERSION,
      closeId: BigInt(snapshot.closeId),
      observedAt: oldestObservedAtSec(snapshot.sources),
      totalAssets: BigInt(snapshot.totalAssets),
      totalLiabilities: BigInt(snapshot.totalLiabilities),
      sourcesHash: snapshot.sourcesHash as Hex,
    },
  ]);
}

export function encodeTopUpBody(intent: TopUpIntent): Hex {
  return encodeAbiParameters(TOP_UP_BODY, [
    {
      version: REPORT_VERSION,
      intentId: intent.intentId as Hex,
      closeId: BigInt(intent.closeId),
      route: routeCode(intent.route),
      amount: BigInt(intent.amount),
      marginRatioBps: intent.marginRatioBps,
      reason: reasonCode(intent.reason),
    },
  ]);
}

export function encodeEnvelope(kind: number, body: Hex): Hex {
  return encodeAbiParameters(ENVELOPE, [kind, body]);
}

export const encodeNavReport = (snapshot: NavSnapshot): Hex => encodeEnvelope(KIND_NAV, encodeNavBody(snapshot));
export const encodeTopUpReport = (intent: TopUpIntent): Hex => encodeEnvelope(KIND_TOP_UP, encodeTopUpBody(intent));

export function decodeEnvelope(report: Hex): { kind: number; body: Hex } {
  const [kind, body] = decodeAbiParameters(ENVELOPE, report);
  return { kind, body };
}

export function decodeNavBody(body: Hex) {
  return decodeAbiParameters(NAV_BODY, body)[0];
}

export function decodeTopUpBody(body: Hex) {
  return decodeAbiParameters(TOP_UP_BODY, body)[0];
}
