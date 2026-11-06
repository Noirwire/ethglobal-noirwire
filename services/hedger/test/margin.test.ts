import { describe, expect, it } from "vitest";
import { topUpIntent } from "@noirwire/shared";
import { buildTopUpIntent, classifyMargin, marginRatioBps } from "../src/margin.ts";
import type { AccountState } from "../src/types.ts";

const BTC = 100_000_000n;
const USD = 1_000_000n;

function account(accountValue: number, marginUsed: number): AccountState {
  return {
    accountValue6: BigInt(accountValue) * USD,
    totalMarginUsed6: BigInt(marginUsed) * USD,
    withdrawable6: BigInt(accountValue - marginUsed) * USD,
    markPx8: 100_000n * BTC,
  };
}

describe("margin ratio bands", () => {
  it("computes the ratio in basis points and classifies the bands", () => {
    expect(marginRatioBps(account(3000, 1000))).toBe(30_000);
    expect(marginRatioBps(account(3000, 0))).toBeNull();
    expect(classifyMargin(30_000)).toBe("ok");
    expect(classifyMargin(19_999)).toBe("low");
    expect(classifyMargin(20_000)).toBe("ok");
    expect(classifyMargin(12_999)).toBe("urgent");
    expect(classifyMargin(40_001)).toBe("surplus");
    expect(classifyMargin(40_000)).toBe("ok");
    expect(classifyMargin(null)).toBe("ok");
  });

  it("asks for a top up below 20000 bps sized to the hedge leverage target", () => {
    const intent = buildTopUpIntent(account(1500, 1000), 50_000_000n, 4, 1_800_000_000_000);
    expect(intent).toMatchObject({
      reason: "margin-low",
      route: "arc-hypercore",
      marginRatioBps: 15_000,
      amount: (11_000n * USD).toString(),
    });
    expect(topUpIntent.safeParse(intent).success).toBe(true);
  });

  it("marks a top up below 13000 bps as urgent", () => {
    const intent = buildTopUpIntent(account(1200, 1000), 50_000_000n, 4, 1_800_000_000_000);
    expect(intent?.reason).toBe("margin-urgent");
    expect(intent?.marginRatioBps).toBe(12_000);
  });

  it("returns surplus above 40000 bps without touching the margin the position needs", () => {
    const intent = buildTopUpIntent(account(5000, 1000), 10_000_000n, 4, 1_800_000_000_000);
    expect(intent).toMatchObject({
      reason: "surplus-return",
      route: "hypercore-arc",
      amount: (2_000n * USD).toString(),
    });
    expect(topUpIntent.safeParse(intent).success).toBe(true);
  });

  it("emits nothing inside the healthy band or with no margin in use", () => {
    expect(buildTopUpIntent(account(2500, 1000), 10_000_000n, 4, 0)).toBeNull();
    expect(buildTopUpIntent(account(2500, 0), 0n, 4, 0)).toBeNull();
  });

  it("produces a stable intent id for the same inputs", () => {
    const a = buildTopUpIntent(account(1500, 1000), 50_000_000n, 4, 1_800_000_000_000);
    const b = buildTopUpIntent(account(1500, 1000), 50_000_000n, 4, 1_800_000_100_000);
    expect(a?.intentId).toBe(b?.intentId);
  });
});
