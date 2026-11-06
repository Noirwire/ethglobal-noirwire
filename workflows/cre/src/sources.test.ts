import { describe, expect, it } from "vitest";
import { aquaInventory, hyperliquidState, inFlightTransfers, makerEquity } from "./dev-stub.ts";
import { parseAquaInventory, parseHyperliquid, parseMakerEquity, parseTransfers } from "./sources.ts";

const NOW = new Date("2026-11-06T07:00:00.000Z");

describe("source parsers", () => {
  it("reads the maker equity contract", () => {
    const parsed = parseMakerEquity(JSON.stringify(makerEquity(NOW)));
    expect(parsed.equityUsdc6).toBe(12_000_000_000n);
    expect(parsed.observedAtMs).toBe(NOW.getTime() - 20_000);
  });

  it("reads the Aqua inventory contract", () => {
    const parsed = parseAquaInventory(JSON.stringify(aquaInventory(NOW)));
    expect(parsed.usdc6).toBe(3_000_000_000n);
    expect(parsed.wbtcE8).toBe(2_000_000n);
  });

  it("reads Hyperliquid margin summary decimals as USDC base units", () => {
    const parsed = parseHyperliquid(JSON.stringify(hyperliquidState(NOW, "healthy")));
    expect(parsed.accountValueUsdc6).toBe(62_804_826n);
    expect(parsed.marginUsedUsdc6).toBe(0n);
    const low = parseHyperliquid(JSON.stringify(hyperliquidState(NOW, "margin-low")));
    expect(low.accountValueUsdc6).toBe(1_500_000_000n);
    expect(low.marginUsedUsdc6).toBe(1_000_000_000n);
  });

  it("validates transfers against the shared schema", () => {
    expect(parseTransfers(JSON.stringify(inFlightTransfers(NOW)))).toHaveLength(4);
    expect(() => parseTransfers(JSON.stringify([{ transferId: "x" }]))).toThrow();
    expect(() => parseTransfers("{}")).toThrow();
  });

  it("keeps the bridge's released flag on a transfer", () => {
    const [first] = inFlightTransfers(NOW);
    const parsed = parseTransfers(JSON.stringify([{ ...first, released: true }, first]));
    expect(parsed[0]?.released).toBe(true);
    expect(parsed[1]?.released).toBeUndefined();
  });

  it("rejects malformed maker and Hyperliquid bodies", () => {
    expect(() => parseMakerEquity(JSON.stringify({ equityUsdc6: "-1", observedAt: NOW.toISOString() }))).toThrow();
    expect(() => parseHyperliquid(JSON.stringify({ marginSummary: {} }))).toThrow();
  });
});
