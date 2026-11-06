import { CCTP_DOMAINS, CCTP_TESTNET_CONTRACTS, EVM_FUNDING_SOURCES, VAULT_HOOK_PARAMS, VAULT_HOOK_VERSION, type EvmFundingSourceId } from "@noirwire/shared";
import { defineChain, encodeAbiParameters, pad, parseAbi, type Address, type Chain, type Hex } from "viem";

export const FAST_FINALITY = 1000;
export const HOOK_DEADLINE_SECONDS = 3600;
export const NONCE_OFFSET = 12;
const NONCE_BYTES = 32;
const BPS_DENOMINATOR = 10_000n;
const FEE_SCALE = 1000n;
const FEE_BUFFER_UNITS = 1n;

export const SOURCE_IDS = Object.keys(EVM_FUNDING_SOURCES) as EvmFundingSourceId[];

export const tokenMessengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

export const hookExecutorAbi = parseAbi(["function processed(bytes32 nonce) view returns (bool)", "function claimable(address beneficiary) view returns (uint256)", "function claim()"]);

export function sourceChain(id: EvmFundingSourceId): Chain {
  const source = EVM_FUNDING_SOURCES[id];
  return defineChain({
    id: source.chainId,
    name: source.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [source.rpcUrl] } },
    blockExplorers: { default: { name: "Explorer", url: source.explorer } },
  });
}

export function sourceTxUrl(id: EvmFundingSourceId, hash: string): string {
  return `${EVM_FUNDING_SOURCES[id].explorer}/tx/${hash}`;
}

export function encodeFundingHook(args: { beneficiary: Address; depositor: Address; deadline: bigint }): Hex {
  return encodeAbiParameters(
    VAULT_HOOK_PARAMS,
    [VAULT_HOOK_VERSION, args.beneficiary, pad(args.depositor, { size: 32 }), args.deadline],
  );
}

export function burnArguments(args: { amount: bigint; source: EvmFundingSourceId; account: Address; hookExecutor: Address; maxFee: bigint; now: number }) {
  const executor = pad(args.hookExecutor, { size: 32 });
  const deadline = BigInt(Math.floor(args.now / 1000) + HOOK_DEADLINE_SECONDS);
  return [
    args.amount,
    CCTP_DOMAINS.arc,
    executor,
    EVM_FUNDING_SOURCES[args.source].usdc as Address,
    executor,
    args.maxFee,
    FAST_FINALITY,
    encodeFundingHook({ beneficiary: args.account, depositor: args.account, deadline }),
  ] as const;
}

export const tokenMessengerAddress = CCTP_TESTNET_CONTRACTS.tokenMessengerV2 as Address;

export function maxFeeFor(amount: bigint, minimumFeeBps: number): bigint {
  const scaled = BigInt(Math.ceil(minimumFeeBps * Number(FEE_SCALE)));
  const fee = (amount * scaled + BPS_DENOMINATOR * FEE_SCALE - 1n) / (BPS_DENOMINATOR * FEE_SCALE);
  return fee + FEE_BUFFER_UNITS;
}

export function fastFeeBps(tiers: { finalityThreshold: number; minimumFee: number }[]): number | null {
  const fast = tiers.find((tier) => tier.finalityThreshold === FAST_FINALITY);
  return fast ? fast.minimumFee : null;
}

export function messageNonce(message: Hex): Hex {
  const start = 2 + NONCE_OFFSET * 2;
  if (message.length < start + NONCE_BYTES * 2) throw new Error("The message is too short to hold a nonce.");
  return `0x${message.slice(start, start + NONCE_BYTES * 2)}` as Hex;
}

export type FundingStep = "approve" | "burn" | "attestation" | "delivered" | "shares";

export const FUNDING_STEPS: readonly FundingStep[] = ["approve", "burn", "attestation", "delivered", "shares"];

export const FUNDING_STEP_LABEL: Record<FundingStep, string> = {
  approve: "Approve USDC",
  burn: "Send from source chain",
  attestation: "Circle attestation",
  delivered: "Delivered to Arc",
  shares: "Vault shares",
};

export type StepStatus = "done" | "active" | "waiting" | "skipped";

export interface FundingProgress {
  needsApproval: boolean;
  approveTx: string | null;
  burnTx: string | null;
  attested: boolean;
  delivered: boolean;
  sharesReady: boolean;
}

export function stepStatuses(progress: FundingProgress): Record<FundingStep, StepStatus> {
  const done: Record<FundingStep, boolean> = {
    approve: progress.approveTx !== null || !progress.needsApproval,
    burn: progress.burnTx !== null,
    attestation: progress.attested,
    delivered: progress.delivered,
    shares: progress.sharesReady,
  };
  const result = {} as Record<FundingStep, StepStatus>;
  let activeFound = false;
  for (const step of FUNDING_STEPS) {
    if (done[step]) {
      result[step] = step === "approve" && !progress.needsApproval && progress.approveTx === null ? "skipped" : "done";
    } else if (!activeFound) {
      result[step] = "active";
      activeFound = true;
    } else {
      result[step] = "waiting";
    }
  }
  return result;
}
