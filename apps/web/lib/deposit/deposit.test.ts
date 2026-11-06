import { describe, expect, it } from "vitest";
import { parseUsdcAmount } from "./amount";
import { base58Encode } from "./base58";
import { parseArcConfig } from "./config";
import { explainWalletError } from "./arc";

describe("parseUsdcAmount", () => {
  it("parses to 6 decimal base units", () => {
    expect(parseUsdcAmount("1")).toEqual({ ok: true, units: 1_000_000n });
    expect(parseUsdcAmount(" 12.5 ")).toEqual({ ok: true, units: 12_500_000n });
    expect(parseUsdcAmount("0.000001")).toEqual({ ok: true, units: 1n });
    expect(parseUsdcAmount(".5")).toEqual({ ok: true, units: 500_000n });
    expect(parseUsdcAmount("3.")).toEqual({ ok: true, units: 3_000_000n });
  });

  it("refuses more than 6 decimals, zero, junk and values past u64", () => {
    expect(parseUsdcAmount("0.0000001")).toMatchObject({ ok: false, reason: expect.stringContaining("6 decimal") });
    expect(parseUsdcAmount("0")).toMatchObject({ ok: false });
    expect(parseUsdcAmount("0.000000")).toMatchObject({ ok: false });
    expect(parseUsdcAmount("")).toMatchObject({ ok: false });
    expect(parseUsdcAmount("-1")).toMatchObject({ ok: false });
    expect(parseUsdcAmount("1e3")).toMatchObject({ ok: false });
    expect(parseUsdcAmount("1,000")).toMatchObject({ ok: false });
    expect(parseUsdcAmount("99999999999999999999999")).toMatchObject({ ok: false, reason: expect.stringContaining("too large") });
  });
});

describe("base58Encode", () => {
  it("matches known vectors", () => {
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58Encode(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(base58Encode(new Uint8Array())).toBe("");
  });
});

describe("parseArcConfig", () => {
  const vault = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";

  it("defaults to Arc testnet and its USDC", () => {
    const result = parseArcConfig({ vault });
    expect(result).toMatchObject({
      ok: true,
      config: { chainId: 5042002, usdc: "0x3600000000000000000000000000000000000000", rpcUrl: "https://rpc.testnet.arc.network" },
    });
  });

  it("takes overrides and drops the explorer off Arc testnet", () => {
    const result = parseArcConfig({ vault, chainId: "31337", rpcUrl: "http://127.0.0.1:8555", usdc: vault });
    expect(result).toMatchObject({ ok: true, config: { chainId: 31337, rpcUrl: "http://127.0.0.1:8555", explorer: null } });
  });

  it("says what is missing or malformed", () => {
    expect(parseArcConfig({})).toMatchObject({ ok: false, reason: expect.stringContaining("NEXT_PUBLIC_SHARE_VAULT_ADDRESS") });
    expect(parseArcConfig({ vault: "nope" })).toMatchObject({ ok: false });
    expect(parseArcConfig({ vault, chainId: "abc" })).toMatchObject({ ok: false });
  });
});

describe("explainWalletError", () => {
  it("turns a rejection into a next step", () => {
    expect(explainWalletError({ code: 4001, message: "User rejected the request." })).toContain("Nothing was sent");
    expect(explainWalletError(new Error("User denied transaction signature"))).toContain("rejected");
  });
});
