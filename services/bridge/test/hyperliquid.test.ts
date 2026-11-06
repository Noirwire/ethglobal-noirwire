import { describe, expect, it } from "vitest";
import { HyperliquidInfoReader } from "../src/hyperliquid.ts";

const fetchReturning = (body: unknown, status = 200) =>
  (async (_url: string, init?: RequestInit) => {
    fetchReturning.lastBody = String(init?.body);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
fetchReturning.lastBody = "";

describe("HyperliquidInfoReader", () => {
  it("reads the perps account value as 6 decimal base units", async () => {
    const reader = new HyperliquidInfoReader("https://hl.example/info", "perps", fetchReturning({ marginSummary: { accountValue: "1234.567891" } }));
    expect(await reader.balance("0xabc")).toBe(1_234_567_891n);
    expect(JSON.parse(fetchReturning.lastBody)).toEqual({ type: "clearinghouseState", user: "0xabc" });
  });

  it("reads the spot USDC total and treats a missing coin as zero", async () => {
    const withUsdc = new HyperliquidInfoReader("https://hl.example/info", "spot", fetchReturning({ balances: [{ coin: "USDC", total: "10.5" }] }));
    expect(await withUsdc.balance("0xabc")).toBe(10_500_000n);
    expect(JSON.parse(fetchReturning.lastBody).type).toBe("spotClearinghouseState");
    const empty = new HyperliquidInfoReader("https://hl.example/info", "spot", fetchReturning({ balances: [] }));
    expect(await empty.balance("0xabc")).toBe(0n);
  });

  it("throws on HTTP errors and malformed bodies instead of reporting zero", async () => {
    await expect(new HyperliquidInfoReader("u", "perps", fetchReturning({}, 500)).balance("0x1")).rejects.toThrow(/500/);
    await expect(new HyperliquidInfoReader("u", "perps", fetchReturning({ nope: 1 })).balance("0x1")).rejects.toThrow();
  });
});
