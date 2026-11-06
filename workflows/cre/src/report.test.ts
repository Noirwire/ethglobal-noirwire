import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  decodeNavBody,
  decodeTopUpBody,
  encodeNavReport,
  encodeTopUpReport,
} from "./report.ts";
import { intentId } from "./nav.ts";
import { navSnapshot, topUpIntent, type NavSnapshot, type TopUpIntent } from "./shared.ts";

const SOURCES_HASH = `0x${"aa".repeat(32)}` as const;
const INTENT_ID = `0x${"bb".repeat(32)}` as const;

const GOLDEN_NAV =
  "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000006aed7960000000000000000000000000000000000000000000000000000000051a7c4c060000000000000000000000000000000000000000000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const GOLDEN_TOP_UP =
  "0x0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000001bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb000000000000000000000000000000000000000000000000000000000000000700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000059682f000000000000000000000000000000000000000000000000000000000000003a980000000000000000000000000000000000000000000000000000000000000000";

const OLDEST_SEC = 1793948000;

const snapshot: NavSnapshot = {
  closeId: 7,
  totalAssets: "21919190022",
  totalLiabilities: "0",
  netAssets: "21919190022",
  shareSupply: "1000000000000000000000",
  sharePriceE18: "21919190022000000000",
  sources: [
    {
      leg: "arc-vault-cash",
      account: "arc:x",
      assets: "5000000000",
      liabilities: "0",
      observedAt: new Date((OLDEST_SEC + 30) * 1000).toISOString(),
      trust: "onchain",
    },
    {
      leg: "solana-maker",
      account: "solana:m",
      assets: "12000000000",
      liabilities: "0",
      observedAt: new Date(OLDEST_SEC * 1000).toISOString(),
      trust: "operator-supplied",
    },
  ],
  sourcesHash: SOURCES_HASH,
  inTransitTransferIds: [],
  takenAt: new Date((OLDEST_SEC + 60) * 1000).toISOString(),
};

const intent: TopUpIntent = {
  intentId: INTENT_ID,
  closeId: 7,
  route: "arc-hypercore",
  amount: "1500000000",
  reason: "margin-low",
  marginRatioBps: 15000,
};

describe("kind 1 NavReport", () => {
  const encoded = encodeNavReport(snapshot);

  it("matches the golden vector produced by an independent encoder", () => {
    expect(encoded).toBe(GOLDEN_NAV);
  });

  it("wraps the body in abi.encode(uint8 kind, bytes body)", () => {
    const { kind, body } = decodeEnvelope(encoded);
    expect(kind).toBe(1);
    expect(body.length).toBe(2 + 6 * 64);
  });

  it("decodes every field", () => {
    const report = decodeNavBody(decodeEnvelope(encoded).body);
    expect(report.version).toBe(1);
    expect(report.closeId).toBe(7n);
    expect(report.observedAt).toBe(BigInt(OLDEST_SEC));
    expect(report.totalAssets).toBe(21919190022n);
    expect(report.totalLiabilities).toBe(0n);
    expect(report.sourcesHash).toBe(SOURCES_HASH);
  });

  it("uses the oldest source timestamp as observedAt", () => {
    const report = decodeNavBody(decodeEnvelope(encoded).body);
    expect(report.observedAt).toBe(1793948000n);
  });
});

describe("kind 2 TopUpIntent", () => {
  const encoded = encodeTopUpReport(intent);

  it("matches the golden vector produced by an independent encoder", () => {
    expect(encoded).toBe(GOLDEN_TOP_UP);
  });

  it("decodes every field", () => {
    const { kind, body } = decodeEnvelope(encoded);
    expect(kind).toBe(2);
    const decoded = decodeTopUpBody(body);
    expect(decoded.version).toBe(1);
    expect(decoded.intentId).toBe(INTENT_ID);
    expect(decoded.closeId).toBe(7n);
    expect(decoded.route).toBe(0);
    expect(decoded.amount).toBe(1500000000n);
    expect(decoded.marginRatioBps).toBe(15000);
    expect(decoded.reason).toBe(0);
  });

  it("encodes route and reason codes for the other variants", () => {
    const surplus: TopUpIntent = {
      ...intent,
      route: "hypercore-arc",
      reason: "surplus-return",
      intentId: intentId(7, "hypercore-arc", 1500000000n, "surplus-return"),
    };
    const decoded = decodeTopUpBody(decodeEnvelope(encodeTopUpReport(surplus)).body);
    expect(decoded.route).toBe(1);
    expect(decoded.reason).toBe(2);
  });
});

describe("shared schema compatibility", () => {
  it("accepts an intent shaped like the shared TopUpIntent", () => {
    expect(topUpIntent.safeParse(intent).success).toBe(true);
  });

  it("rejects a snapshot missing the shared required fields", () => {
    expect(navSnapshot.safeParse({ closeId: 1 }).success).toBe(false);
  });
});
