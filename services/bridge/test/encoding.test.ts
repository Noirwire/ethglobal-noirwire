import { describe, expect, it } from "vitest";
import { decodeVaultHookData, encodeForwardHookData, encodeVaultHookData, HYPERCORE_DEX } from "../src/hooks.ts";
import { decodeBurnBody, decodeMessage, messageHash } from "../src/message.ts";
import { buildBurnMessage, word } from "./helpers.ts";

describe("vault hookData", () => {
  const beneficiary = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const depositor = `0x${"ab".repeat(32)}` as const;

  it("matches the golden vector for abi.encode(uint8,address,bytes32,uint64)", () => {
    const encoded = encodeVaultHookData({ beneficiary, solanaDepositor: depositor, deadline: 1_800_000_000n });
    expect(encoded).toBe(
      "0x" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8" +
        "ab".repeat(32) +
        "000000000000000000000000000000000000000000000000000000006b49d200",
    );
  });

  it("round trips", () => {
    const encoded = encodeVaultHookData({ beneficiary, solanaDepositor: depositor, deadline: 42n });
    expect(decodeVaultHookData(encoded)).toEqual({ version: 1, beneficiary, solanaDepositor: depositor, deadline: 42n });
  });

  it("rejects a non-address beneficiary", () => {
    expect(() => encodeVaultHookData({ beneficiary: "0x1234", solanaDepositor: depositor, deadline: 1n })).toThrow();
  });
});

describe("CctpForwarder hookData", () => {
  it("matches the documented 56 byte layout for perps and spot", () => {
    const recipient = "0x1234567890abcdef1234567890abcdef12345678";
    const perps = encodeForwardHookData(recipient, HYPERCORE_DEX.perps);
    expect(perps).toBe(
      "0x636374702d666f7277617264" + "0".repeat(24) + "00000000" + "00000018" + recipient.slice(2) + "00000000",
    );
    expect((perps.length - 2) / 2).toBe(56);
    expect(encodeForwardHookData(recipient, HYPERCORE_DEX.spot).endsWith("ffffffff")).toBe(true);
  });
});

describe("CCTP V2 message codec", () => {
  it("round trips header and burn body at the offsets HookExecutor reads", () => {
    const hookData = encodeVaultHookData({
      beneficiary: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      solanaDepositor: `0x${"cd".repeat(32)}`,
      deadline: 7n,
    });
    const message = buildBurnMessage({ amount: 12_345_678n, feeExecuted: 1_000n, hookData, nonce: word(99) });
    const header = decodeMessage(message);
    expect(header).toMatchObject({ version: 1, sourceDomain: 5, destinationDomain: 26, nonce: word(99) });
    const body = decodeBurnBody(header.body);
    expect(body).toMatchObject({ amount: 12_345_678n, feeExecuted: 1_000n, hookData });
    expect(message.slice(2 + 2 * (148 + 68), 2 + 2 * (148 + 100))).toBe(word(12_345_678n).slice(2));
    expect(messageHash(message)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects truncated input", () => {
    expect(() => decodeMessage("0x00")).toThrow();
    expect(() => decodeBurnBody("0x00")).toThrow();
  });
});
