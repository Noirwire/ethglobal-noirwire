import { describe, expect, it } from "vitest";
import { CCTP_DOMAINS, CCTP_TESTNET_CONTRACTS, EVM_FUNDING_SOURCES } from "./chains.ts";

describe("EVM funding sources", () => {
  it("uses the CCTP domains and distinct chains", () => {
    const sources = Object.values(EVM_FUNDING_SOURCES);
    expect(sources.map((source) => source.cctpDomain).sort()).toEqual([CCTP_DOMAINS.ethereum, CCTP_DOMAINS.arbitrum, CCTP_DOMAINS.base].sort());
    expect(new Set(sources.map((source) => source.chainId)).size).toBe(sources.length);
    expect(new Set(sources.map((source) => source.usdc.toLowerCase())).size).toBe(sources.length);
  });

  it("holds well formed addresses", () => {
    const addresses = [...Object.values(EVM_FUNDING_SOURCES).map((source) => source.usdc), ...Object.values(CCTP_TESTNET_CONTRACTS)];
    for (const address of addresses) expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
