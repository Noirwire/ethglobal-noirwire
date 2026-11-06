import { describe, expect, it } from "vitest";
import {
  assertSourcesUsable,
  buildSnapshot,
  intentId,
  marginRatioBps,
  parseDecimalToUnits,
  planTopUp,
  selectInTransit,
  sharePriceE18,
  sourcesHash,
  valueWbtcInUsdc6,
  type BridgeTransferView,
  type MarginBands,
  type Readings,
} from "./nav.ts";
import { navSnapshot, topUpIntent, type BridgeTransfer, type NavSource } from "@noirwire/shared";

const NOW = new Date("2026-11-06T07:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

const BANDS: MarginBands = {
  lowBps: 20000,
  urgentBps: 13000,
  surplusBps: 40000,
  targetBps: 30000,
  maxIntentUsdc6: "5000000000",
};

function transfer(overrides: Partial<BridgeTransferView> & { transferId: string }): BridgeTransferView {
  return {
    route: "arc-solana",
    sourceDomain: 26,
    destinationDomain: 5,
    grossAmount: "100000000",
    maxFee: "10000",
    state: "burned",
    attester: "local-test-attester",
    updatedAt: ago(60).toISOString(),
    ...overrides,
  };
}

function readings(overrides: Partial<Readings> = {}): Readings {
  return {
    vaultCash: { account: "arc:vault", usdc6: 5_000_000_000n, observedAt: ago(1) },
    maker: { account: "solana:maker", equityUsdc6: 12_000_000_000n, observedAt: ago(20) },
    hyperliquid: { account: "hyperliquid:0xabc", accountValueUsdc6: 1_500_000_000n, observedAt: ago(5) },
    aqua: {
      account: "aqua:fork",
      usdc6: 3_000_000_000n,
      wbtcE8: 2_000_000n,
      btcUsdE8: 7_500_000_000_000n,
      observedAt: ago(30),
    },
    transfers: { account: "cctp:in-transit", items: [], observedAt: ago(1) },
    shareSupply18: 1_000n * 10n ** 18n,
    ...overrides,
  };
}

describe("in-transit selection", () => {
  it("counts a transfer once even when the API lists it twice, keeping the latest state", () => {
    const items = [
      transfer({ transferId: "a", state: "requested", updatedAt: ago(200).toISOString() }),
      transfer({ transferId: "a", state: "burned", updatedAt: ago(100).toISOString() }),
    ];
    const selected = selectInTransit(items);
    expect(selected.map((t) => t.transferId)).toEqual(["a"]);
    expect(selected[0]?.state).toBe("burned");
  });

  it("drops settled and failed transfers", () => {
    const items = ["credited", "vault-credited", "claimable", "failed"].map((state, index) =>
      transfer({ transferId: `s${index}`, state: state as BridgeTransfer["state"] }),
    );
    expect(selectInTransit(items)).toEqual([]);
  });

  it("keeps stuck and minted transfers, which are neither settled nor still on the source", () => {
    const items = [transfer({ transferId: "m", state: "minted" }), transfer({ transferId: "k", state: "stuck" })];
    expect(selectInTransit(items).map((t) => t.transferId)).toEqual(["k", "m"]);
  });

  it("ignores a transfer that has not burned yet, because the source leg still holds it", () => {
    expect(selectInTransit([transfer({ transferId: "r", state: "requested" })])).toEqual([]);
  });

  it("counts a requested transfer once the bridge says its USDC has left the vault", () => {
    const items = [
      transfer({ transferId: "held", state: "requested", released: true }),
      transfer({ transferId: "waiting", state: "requested", released: false }),
    ];
    expect(selectInTransit(items).map((t) => t.transferId)).toEqual(["held"]);
  });

  it("does not count a stuck transfer whose release never happened", () => {
    const items = [
      transfer({ transferId: "never", state: "stuck", released: false }),
      transfer({ transferId: "moved", state: "stuck", released: true }),
    ];
    expect(selectInTransit(items).map((t) => t.transferId)).toEqual(["moved"]);
  });

  it("drops a released transfer once it settles", () => {
    expect(selectInTransit([transfer({ transferId: "done", state: "credited", released: true })])).toEqual([]);
  });

  it("values a transfer at netMinted when known, else the gross amount", () => {
    const snap = buildSnapshot({
      closeId: 1,
      now: NOW,
      maxSourceAgeSec: 900,
      readings: readings({
        transfers: {
          account: "cctp:in-transit",
          observedAt: ago(1),
          items: [
            transfer({ transferId: "a", grossAmount: "250000000" }),
            transfer({ transferId: "b", grossAmount: "100000000", netMinted: "99990000", state: "minted" }),
          ],
        },
      }),
    });
    const leg = snap.sources.find((s) => s.leg === "in-transit");
    expect(leg?.assets).toBe("349990000");
    expect(snap.inTransitTransferIds).toEqual(["a", "b"]);
  });
});

describe("buildSnapshot", () => {
  const snap = buildSnapshot({ closeId: 7, now: NOW, maxSourceAgeSec: 900, readings: readings() });

  it("has every leg once, in a fixed order, with its trust label", () => {
    expect(snap.sources.map((s) => [s.leg, s.trust])).toEqual([
      ["arc-vault-cash", "onchain"],
      ["solana-maker", "operator-supplied"],
      ["hyperliquid", "venue-api"],
      ["aqua", "operator-supplied"],
      ["in-transit", "operator-supplied"],
    ]);
  });

  it("values the Aqua leg as USDC plus WBTC at the feed price", () => {
    expect(valueWbtcInUsdc6(2_000_000n, 7_500_000_000_000n)).toBe(1_500_000_000n);
    const aqua = snap.sources.find((s) => s.leg === "aqua");
    expect(aqua?.assets).toBe("4500000000");
    expect(aqua?.btcPosition).toBe("2000000");
    expect(aqua?.valuationPrice).toBe("75000");
  });

  it("sums totals across legs", () => {
    expect(snap.totalAssets).toBe((5_000_000_000n + 12_000_000_000n + 1_500_000_000n + 4_500_000_000n).toString());
    expect(snap.totalLiabilities).toBe("0");
    expect(snap.netAssets).toBe(snap.totalAssets);
  });

  it("derives the share price from net assets and supply", () => {
    expect(snap.sharePriceE18).toBe(sharePriceE18(BigInt(snap.netAssets), 1_000n * 10n ** 18n).toString());
    expect(snap.sharePriceE18).toBe("23000000000000000000");
  });

  it("passes the shared NavSnapshot schema", () => {
    expect(navSnapshot.safeParse(snap).success).toBe(true);
  });

  it("carries a sourcesHash equal to hashing its own sources", () => {
    expect(snap.sourcesHash).toBe(sourcesHash(snap.sources));
  });

  it("refuses when any source is older than the limit", () => {
    const stale = readings({ maker: { account: "solana:maker", equityUsdc6: 1n, observedAt: ago(901) } });
    expect(() => buildSnapshot({ closeId: 1, now: NOW, maxSourceAgeSec: 900, readings: stale })).toThrow(
      /stale source solana-maker/,
    );
  });

  it("accepts a source exactly at the limit", () => {
    const edge = readings({ maker: { account: "solana:maker", equityUsdc6: 1n, observedAt: ago(900) } });
    expect(() => buildSnapshot({ closeId: 1, now: NOW, maxSourceAgeSec: 900, readings: edge })).not.toThrow();
  });

  it("refuses an unreadable timestamp", () => {
    const bad = readings({ maker: { account: "solana:maker", equityUsdc6: 1n, observedAt: new Date("nope") } });
    expect(() => buildSnapshot({ closeId: 1, now: NOW, maxSourceAgeSec: 900, readings: bad })).toThrow(/unreadable/);
  });

  it("refuses when a leg is missing", () => {
    const missing = snap.sources.filter((s) => s.leg !== "hyperliquid");
    expect(() => assertSourcesUsable(missing, NOW, 900)).toThrow(/missing source: hyperliquid/);
  });
});

describe("share price", () => {
  it("is 1e18 at zero supply", () => {
    expect(sharePriceE18(123n, 0n)).toBe(10n ** 18n);
  });

  it("rounds down", () => {
    expect(sharePriceE18(1n, 3n * 10n ** 18n)).toBe(333333333333n);
  });
});

describe("sourcesHash", () => {
  const a: NavSource = {
    leg: "arc-vault-cash",
    account: "arc:x",
    assets: "5000000000",
    liabilities: "0",
    observedAt: new Date(1793948000 * 1000).toISOString(),
    trust: "onchain",
  };
  const b: NavSource = {
    leg: "solana-maker",
    account: "solana:m",
    assets: "12000000000",
    liabilities: "0",
    observedAt: new Date(1793948010 * 1000).toISOString(),
    trust: "operator-supplied",
  };

  it("matches the golden value from an independent encoder", () => {
    expect(sourcesHash([a, b])).toBe("0x1eeb1cd2ecbf4c5e0bd326fee5b8a9825b8163d37c6ab480ed2ee31f2947d902");
  });

  it("does not depend on input order", () => {
    expect(sourcesHash([b, a])).toBe(sourcesHash([a, b]));
  });

  it("changes when an amount changes", () => {
    expect(sourcesHash([{ ...a, assets: "5000000001" }, b])).not.toBe(sourcesHash([a, b]));
  });

  it("sorts two records on the same leg by account hash", () => {
    const c = { ...a, account: "arc:y" };
    expect(sourcesHash([c, a, b])).toBe(sourcesHash([a, c, b]));
  });
});

describe("margin ratio", () => {
  it("is account value over margin used in bps", () => {
    expect(marginRatioBps(1_500_000_000n, 1_000_000_000n)).toBe(15000n);
  });

  it("is null when no margin is used", () => {
    expect(marginRatioBps(62_804_826n, 0n)).toBeNull();
  });
});

describe("planTopUp", () => {
  const plan = (accountValue: bigint, marginUsed: bigint, bands = BANDS) =>
    planTopUp({ closeId: 7, accountValueUsdc6: accountValue, marginUsedUsdc6: marginUsed, bands });

  it("does nothing when no margin is used", () => {
    expect(plan(62_804_826n, 0n)).toBeNull();
  });

  it("does nothing inside the bands, including both edges", () => {
    expect(plan(2_000_000_000n, 1_000_000_000n)).toBeNull();
    expect(plan(4_000_000_000n, 1_000_000_000n)).toBeNull();
    expect(plan(3_000_000_000n, 1_000_000_000n)).toBeNull();
  });

  it("asks for margin-low just under the low band", () => {
    const intent = plan(1_999_900_000n, 1_000_000_000n);
    expect(intent?.reason).toBe("margin-low");
    expect(intent?.route).toBe("arc-hypercore");
    expect(intent?.marginRatioBps).toBe(19999);
  });

  it("is urgent below the urgent band and low at its edge", () => {
    expect(plan(1_299_900_000n, 1_000_000_000n)?.reason).toBe("margin-urgent");
    expect(plan(1_300_000_000n, 1_000_000_000n)?.reason).toBe("margin-low");
  });

  it("sizes the top-up to restore the target ratio", () => {
    const intent = plan(1_500_000_000n, 1_000_000_000n);
    expect(intent?.amount).toBe("1500000000");
    const restored = marginRatioBps(1_500_000_000n + BigInt(intent!.amount), 1_000_000_000n);
    expect(restored).toBe(30000n);
  });

  it("rounds a top-up up so the target is never undershot", () => {
    const intent = plan(600_000n, 333_333n);
    expect(intent?.reason).toBe("margin-low");
    const restored = marginRatioBps(600_000n + BigInt(intent!.amount), 333_333n);
    expect(restored! >= 30000n).toBe(true);
  });

  it("bounds the amount by the per-intent maximum", () => {
    const intent = plan(100_000_000n, 10_000_000_000n);
    expect(intent?.reason).toBe("margin-urgent");
    expect(intent?.amount).toBe(BANDS.maxIntentUsdc6);
  });

  it("returns surplus above the surplus band down to the target", () => {
    const intent = plan(5_000_000_000n, 1_000_000_000n);
    expect(intent?.reason).toBe("surplus-return");
    expect(intent?.route).toBe("hypercore-arc");
    expect(intent?.amount).toBe("2000000000");
    expect(marginRatioBps(5_000_000_000n - 2_000_000_000n, 1_000_000_000n)).toBe(30000n);
  });

  it("bounds a surplus return by the maximum too", () => {
    expect(plan(50_000_000_000n, 1_000_000_000n)?.amount).toBe(BANDS.maxIntentUsdc6);
  });

  it("caps the reported ratio at uint16", () => {
    expect(plan(900_000_000_000n, 1_000_000n)?.marginRatioBps).toBe(65535);
  });

  it("produces an intent the shared schema accepts", () => {
    expect(topUpIntent.safeParse(plan(1_500_000_000n, 1_000_000_000n)).success).toBe(true);
  });
});

describe("intentId", () => {
  it("is deterministic and depends on every input", () => {
    const base = intentId(7, "arc-hypercore", 1500n, "margin-low");
    expect(intentId(7, "arc-hypercore", 1500n, "margin-low")).toBe(base);
    expect(intentId(8, "arc-hypercore", 1500n, "margin-low")).not.toBe(base);
    expect(intentId(7, "hypercore-arc", 1500n, "margin-low")).not.toBe(base);
    expect(intentId(7, "arc-hypercore", 1501n, "margin-low")).not.toBe(base);
    expect(intentId(7, "arc-hypercore", 1500n, "margin-urgent")).not.toBe(base);
  });
});

describe("parseDecimalToUnits", () => {
  it("scales decimals and truncates extra digits", () => {
    expect(parseDecimalToUnits("62.804826", 6)).toBe(62_804_826n);
    expect(parseDecimalToUnits("1.23456789", 6)).toBe(1_234_567n);
    expect(parseDecimalToUnits("0.0", 6)).toBe(0n);
    expect(parseDecimalToUnits("-1.5", 6)).toBe(-1_500_000n);
  });

  it("rejects non-numbers", () => {
    expect(() => parseDecimalToUnits("abc", 6)).toThrow();
  });
});
