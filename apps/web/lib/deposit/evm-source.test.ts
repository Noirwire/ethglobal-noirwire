import { CCTP_DOMAINS, EVM_FUNDING_SOURCES } from "@noirwire/shared";
import { decodeAbiParameters, pad, type Address, type Hex } from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import {
  burnArguments,
  encodeFundingHook,
  fastFeeBps,
  FAST_FINALITY,
  maxFeeFor,
  messageNonce,
  stepStatuses,
  type FundingProgress,
} from "./evm-source";
import { parseTradeUrl } from "../trade-url";
import { lockupRemainingSeconds, parseShareAmount, shareValueUsdc, withdrawStage, withdrawStepStatuses } from "./position";

const account = "0x1111111111111111111111111111111111111111" as Address;
const executor = "0x2222222222222222222222222222222222222222" as Address;

describe("funding sources", () => {
  it("match the chains viem knows", () => {
    expect(EVM_FUNDING_SOURCES.ethereumSepolia.chainId).toBe(sepolia.id);
    expect(EVM_FUNDING_SOURCES.baseSepolia.chainId).toBe(baseSepolia.id);
    expect(EVM_FUNDING_SOURCES.arbitrumSepolia.chainId).toBe(arbitrumSepolia.id);
  });
});

describe("encodeFundingHook", () => {
  it("is 128 bytes in the layout the HookExecutor decodes", () => {
    const hook = encodeFundingHook({ beneficiary: account, depositor: account, deadline: 1234n });
    expect((hook.length - 2) / 2).toBe(128);
    const [version, beneficiary, depositor, deadline] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
      hook,
    );
    expect(version).toBe(1);
    expect(beneficiary.toLowerCase()).toBe(account);
    expect(depositor).toBe(pad(account, { size: 32 }));
    expect(deadline).toBe(1234n);
  });
});

describe("burnArguments", () => {
  it("targets Arc with the executor as recipient and caller, fast finality and the picked chain's USDC", () => {
    const args = burnArguments({ amount: 5_000_000n, source: "baseSepolia", account, hookExecutor: executor, maxFee: 600n, now: 1_000_000 });
    expect(args[0]).toBe(5_000_000n);
    expect(args[1]).toBe(CCTP_DOMAINS.arc);
    expect(args[2]).toBe(pad(executor, { size: 32 }));
    expect(args[3]).toBe(EVM_FUNDING_SOURCES.baseSepolia.usdc);
    expect(args[4]).toBe(args[2]);
    expect(args[5]).toBe(600n);
    expect(args[6]).toBe(FAST_FINALITY);
    const [, , , deadline] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
      args[7],
    );
    expect(deadline).toBe(1000n + 3600n);
  });
});

describe("fees", () => {
  it("rounds the fee up from basis points and adds one unit of headroom", () => {
    expect(maxFeeFor(1_000_000n, 1)).toBe(100n + 1n);
    expect(maxFeeFor(1_000_000n, 1.3)).toBe(130n + 1n);
    expect(maxFeeFor(1n, 1)).toBe(2n);
    expect(maxFeeFor(1_000_000n, 0)).toBe(1n);
  });

  it("reads the fast tier", () => {
    expect(fastFeeBps([{ finalityThreshold: 2000, minimumFee: 0 }, { finalityThreshold: 1000, minimumFee: 1.3 }])).toBe(1.3);
    expect(fastFeeBps([{ finalityThreshold: 2000, minimumFee: 0 }])).toBeNull();
  });
});

describe("messageNonce", () => {
  it("reads the 32 bytes after version and source domain", () => {
    const nonce = `${"ab".repeat(32)}`;
    const message = `0x${"00000001"}${"00000000"}${"00000000"}${nonce}${"cd".repeat(40)}` as Hex;
    expect(messageNonce(message)).toBe(`0x${nonce}`);
    expect(() => messageNonce("0x00")).toThrow();
  });
});

describe("stepStatuses", () => {
  const base: FundingProgress = { needsApproval: true, approveTx: null, burnTx: null, attested: false, delivered: false, sharesReady: false };

  it("starts at approval", () => {
    expect(stepStatuses(base)).toEqual({ approve: "active", burn: "waiting", attestation: "waiting", delivered: "waiting", shares: "waiting" });
  });

  it("skips approval when allowance is enough", () => {
    expect(stepStatuses({ ...base, needsApproval: false }).approve).toBe("skipped");
    expect(stepStatuses({ ...base, needsApproval: false }).burn).toBe("active");
  });

  it("advances one active step at a time", () => {
    const afterBurn = stepStatuses({ ...base, approveTx: "0xa", burnTx: "0xb" });
    expect(afterBurn).toEqual({ approve: "done", burn: "done", attestation: "active", delivered: "waiting", shares: "waiting" });
    const delivered = stepStatuses({ ...base, approveTx: "0xa", burnTx: "0xb", attested: true, delivered: true });
    expect(delivered.shares).toBe("active");
    expect(stepStatuses({ ...base, approveTx: "0xa", burnTx: "0xb", attested: true, delivered: true, sharesReady: true }).shares).toBe("done");
  });
});

describe("position maths", () => {
  it("values shares at the last price in USDC base units", () => {
    expect(shareValueUsdc(10n * 10n ** 18n, 10n ** 18n)).toBe(10_000_000n);
    expect(shareValueUsdc(2n * 10n ** 18n, 1_050_000_000_000_000_000n)).toBe(2_100_000n);
    expect(shareValueUsdc(0n, 10n ** 18n)).toBe(0n);
  });

  it("parses share amounts against the balance", () => {
    const balance = 5n * 10n ** 18n;
    expect(parseShareAmount("1.5", balance)).toEqual({ ok: true, units: 15n * 10n ** 17n });
    expect(parseShareAmount("6", balance)).toMatchObject({ ok: false });
    expect(parseShareAmount("0", balance)).toMatchObject({ ok: false });
    expect(parseShareAmount("", balance)).toMatchObject({ ok: false });
    expect(parseShareAmount("1e3", balance)).toMatchObject({ ok: false });
  });

  it("classifies the withdrawal stage", () => {
    const none = { redeem: { epoch: 0n, shares: 0n }, currentEpoch: 3n, claimableAssets: 0n };
    expect(withdrawStage(none)).toBe("none");
    expect(withdrawStage({ ...none, redeem: { epoch: 3n, shares: 5n } })).toBe("waiting-for-close");
    expect(withdrawStage({ ...none, redeem: { epoch: 0n, shares: 0n }, claimableAssets: 9n })).toBe("ready-to-claim");
    expect(withdrawStage({ ...none, redeem: { epoch: 3n, shares: 2n }, claimableAssets: 9n })).toBe("partly-carried");
    expect(withdrawStepStatuses("waiting-for-close")).toEqual(["done", "active", "waiting"]);
    expect(withdrawStepStatuses("ready-to-claim")).toEqual(["done", "done", "active"]);
  });

  it("counts the lockup down to zero", () => {
    expect(lockupRemainingSeconds(1000n, 400)).toBe(600);
    expect(lockupRemainingSeconds(1000n, 2000)).toBe(0);
  });
});

describe("parseTradeUrl", () => {
  it("accepts http(s) and hides everything else", () => {
    expect(parseTradeUrl("https://trade.example.com")).toBe("https://trade.example.com/");
    expect(parseTradeUrl("  ")).toBeNull();
    expect(parseTradeUrl(undefined)).toBeNull();
    expect(parseTradeUrl("javascript:alert(1)")).toBeNull();
    expect(parseTradeUrl("not a url")).toBeNull();
  });
});
