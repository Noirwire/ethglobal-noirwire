import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCTP_DOMAINS } from "@noirwire/shared";
import { padHex, toHex, type Hex } from "viem";
import { BURN_BODY_VERSION, encodeBurnBody, encodeMessage, FINALITY_FAST, MESSAGE_VERSION } from "../src/message.ts";
import type { RouteAdapter } from "../src/executor.ts";
import type { NewTransfer } from "../src/transfers.ts";

export const idleAdapter: RouteAdapter = {
  burn: async () => {
    throw new Error("not under test");
  },
  messageFor: async () => undefined,
  deliver: async () => ({ status: "pending", reason: "idle" }),
};

export function tempJournal(): string {
  return join(mkdtempSync(join(tmpdir(), "bridge-")), "transfers.ndjson");
}

export function clock(start = "2026-11-06T10:00:00.000Z") {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
  };
}

export function word(value: bigint | number): Hex {
  return padHex(toHex(value), { size: 32 });
}

export function buildBurnMessage(
  overrides: Partial<{
    sourceDomain: number;
    destinationDomain: number;
    nonce: Hex;
    amount: bigint;
    feeExecuted: bigint;
    hookData: Hex;
    sender: Hex;
    recipient: Hex;
    destinationCaller: Hex;
    mintRecipient: Hex;
    burnToken: Hex;
  }> = {},
): Hex {
  const mintRecipient = overrides.mintRecipient ?? word(0xabc);
  return encodeMessage({
    version: MESSAGE_VERSION,
    sourceDomain: overrides.sourceDomain ?? CCTP_DOMAINS.solana,
    destinationDomain: overrides.destinationDomain ?? CCTP_DOMAINS.arc,
    nonce: overrides.nonce ?? word(1),
    sender: overrides.sender ?? word(0x111),
    recipient: overrides.recipient ?? word(0x222),
    destinationCaller: overrides.destinationCaller ?? mintRecipient,
    minFinalityThreshold: FINALITY_FAST,
    finalityThresholdExecuted: FINALITY_FAST,
    body: encodeBurnBody({
      version: BURN_BODY_VERSION,
      burnToken: overrides.burnToken ?? word(0x333),
      mintRecipient,
      amount: overrides.amount ?? 5_000_000n,
      messageSender: word(0x444),
      maxFee: 1000n,
      feeExecuted: overrides.feeExecuted ?? 500n,
      expirationBlock: 0n,
      hookData: overrides.hookData ?? "0x",
    }),
  });
}

export function newTransfer(overrides: Partial<NewTransfer> = {}): NewTransfer {
  return {
    transferId: "t1",
    route: "solana-arc",
    sourceDomain: CCTP_DOMAINS.solana,
    destinationDomain: CCTP_DOMAINS.arc,
    grossAmount: "5000000",
    maxFee: "1000",
    attester: "local-test-attester",
    ...overrides,
  };
}
