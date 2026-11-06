import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { padHex, toHex, type Hex } from "viem";
import { encodeBurnBody, encodeMessage } from "../src/message.ts";
import type { NewTransfer } from "../src/transfers.ts";

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
    version: 1,
    sourceDomain: overrides.sourceDomain ?? 5,
    destinationDomain: overrides.destinationDomain ?? 26,
    nonce: overrides.nonce ?? word(1),
    sender: overrides.sender ?? word(0x111),
    recipient: overrides.recipient ?? word(0x222),
    destinationCaller: overrides.destinationCaller ?? mintRecipient,
    minFinalityThreshold: 1000,
    finalityThresholdExecuted: 1000,
    body: encodeBurnBody({
      version: 1,
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
    sourceDomain: 5,
    destinationDomain: 26,
    grossAmount: "5000000",
    maxFee: "1000",
    attester: "local-test-attester",
    ...overrides,
  };
}
