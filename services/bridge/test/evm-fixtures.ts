import { CCTP_DOMAINS, CCTP_TESTNET_CONTRACTS, EVM_FUNDING_SOURCES } from "@noirwire/shared";
import type { Hex } from "viem";
import type { EvmDepositSource } from "../src/evm-deposit.ts";
import { encodeVaultHookData } from "../src/hooks.ts";
import { addressToBytes32, BURN_BODY_VERSION, encodeBurnBody, encodeMessage, FINALITY_FAST, MESSAGE_VERSION, ZERO_BYTES32 } from "../src/message.ts";

export const DEPOSITOR: Hex = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const SOURCE_BENEFICIARY: Hex = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export const SOURCES: Record<number, EvmDepositSource> = Object.fromEntries(
  Object.values(EVM_FUNDING_SOURCES).map((source) => [
    source.cctpDomain,
    {
      label: source.label,
      tokenMessenger: CCTP_TESTNET_CONTRACTS.tokenMessengerV2,
      messageTransmitter: CCTP_TESTNET_CONTRACTS.messageTransmitterV2,
      usdc: source.usdc,
    },
  ]),
);

export type SourceMessageOptions = Partial<{
  hookExecutor: Hex;
  localTokenMessenger: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  mintRecipient: Hex;
  burnToken: Hex;
  destinationDomain: number;
  hookData: Hex;
  messageSender: Hex;
  amount: bigint;
  beneficiary: Hex;
  nonce: Hex;
  feeExecuted: bigint;
  finalityThresholdExecuted: number;
}>;

export const DEFAULT_HOOK_EXECUTOR: Hex = "0x00000000000000000000000000000000000000ee";

export function sourceMessage(domain: number, overrides: SourceMessageOptions = {}): Hex {
  const source = SOURCES[domain]!;
  const executor = addressToBytes32(overrides.hookExecutor ?? DEFAULT_HOOK_EXECUTOR);
  const depositor = addressToBytes32(DEPOSITOR);
  return encodeMessage({
    version: MESSAGE_VERSION,
    sourceDomain: domain,
    destinationDomain: overrides.destinationDomain ?? CCTP_DOMAINS.arc,
    nonce: overrides.nonce ?? ZERO_BYTES32,
    sender: overrides.sender ?? addressToBytes32(source.tokenMessenger),
    recipient: overrides.recipient ?? addressToBytes32(overrides.localTokenMessenger ?? CCTP_TESTNET_CONTRACTS.tokenMessengerV2),
    destinationCaller: overrides.destinationCaller ?? executor,
    minFinalityThreshold: FINALITY_FAST,
    finalityThresholdExecuted: overrides.finalityThresholdExecuted ?? 0,
    body: encodeBurnBody({
      version: BURN_BODY_VERSION,
      burnToken: overrides.burnToken ?? addressToBytes32(source.usdc),
      mintRecipient: overrides.mintRecipient ?? executor,
      amount: overrides.amount ?? 3_000_000n,
      messageSender: overrides.messageSender ?? depositor,
      maxFee: 2_000n,
      feeExecuted: overrides.feeExecuted ?? 0n,
      expirationBlock: 0n,
      hookData:
        overrides.hookData ??
        encodeVaultHookData({ beneficiary: overrides.beneficiary ?? SOURCE_BENEFICIARY, solanaDepositor: depositor, deadline: 1_900_000_000n }),
    }),
  });
}
