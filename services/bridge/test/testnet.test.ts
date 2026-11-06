import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { IrisClient } from "../src/iris.ts";
import { assertSameHyperCoreAccount, wireTestnet } from "../src/testnet.ts";

const ACCOUNT_KEY: `0x${string}` = `0x${"22".repeat(32)}`;
const SIGNER = privateKeyToAccount(ACCOUNT_KEY).address;
const OTHER = "0x00000000000000000000000000000000000000cc";

describe("the HyperCore account", () => {
  it("accepts a recipient equal to the signer in any case, or either one alone", () => {
    expect(() => assertSameHyperCoreAccount(SIGNER.toLowerCase(), SIGNER)).not.toThrow();
    expect(() => assertSameHyperCoreAccount(undefined, SIGNER)).not.toThrow();
    expect(() => assertSameHyperCoreAccount(OTHER, undefined)).not.toThrow();
  });

  it("refuses startup when HYPERCORE_RECIPIENT differs from the address of HYPERCORE_ACCOUNT_KEY", () => {
    expect(() => assertSameHyperCoreAccount(OTHER, SIGNER)).toThrow(/HYPERCORE_RECIPIENT/);
    const env = (name: string) =>
      ({ ARC_OPERATOR_KEY: `0x${"11".repeat(32)}`, HYPERCORE_ACCOUNT_KEY: ACCOUNT_KEY, HYPERCORE_RECIPIENT: OTHER })[name];
    const config = { routes: {}, allowlist: new Set<string>(), dailyCap: 1n, defaultPerTransferCap: 1n, stuckTimeoutMs: 1, stuckRetryMs: 1 };
    expect(() => wireTestnet(env, new IrisClient(), {}, config)).toThrow(/HYPERCORE_RECIPIENT/);
  });
});
