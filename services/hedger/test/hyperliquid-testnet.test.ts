import { describe, expect, it } from "vitest";
import { fetchHyperliquidSpec } from "../src/venue/hyperliquid-venue.ts";

describe.skipIf(process.env.HL_TESTNET_READ !== "1")("Hyperliquid testnet info endpoint (read only)", () => {
  it("serves BTC perp metadata with szDecimals and max leverage", async () => {
    const spec = await fetchHyperliquidSpec("BTC", true);
    console.log(`testnet BTC: assetIndex=${spec.assetIndex} szDecimals=${spec.szDecimals} maxLeverage=${spec.maxLeverage}`);
    expect(spec.coin).toBe("BTC");
    expect(Number.isInteger(spec.szDecimals)).toBe(true);
    expect(spec.szDecimals).toBeGreaterThanOrEqual(0);
    expect(spec.maxLeverage).toBeGreaterThan(1);
  }, 30_000);
});
