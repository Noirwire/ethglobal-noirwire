import { parseAbi, parseUnits, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { arcChain } from "./arc";
import type { ArcConfig } from "./config";
import { hookExecutorAbi, type StepStatus } from "./evm-source";

const SHARE_DECIMALS = 18;
const PRICE_SCALE = 10n ** 18n;
const SHARE_TO_USDC = 10n ** 12n;

export const vaultPositionAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function lastPrice() view returns (uint256)",
  "function currentEpoch() view returns (uint64)",
  "function lockedUntil(address user) view returns (uint256)",
  "function requestsPaused() view returns (bool)",
  "function stalled() view returns (bool)",
  "function pendingClaims(address user) view returns (uint256 shares, uint256 assets)",
  "function depositRequests(address user) view returns (uint64 epoch, uint192 assets)",
  "function redeemRequests(address user) view returns (uint64 epoch, uint192 shares)",
  "function requestRedeem(uint256 shares, address receiver)",
  "function cancelRedeem()",
  "function claimShares(address user)",
  "function claimAssets(address user)",
]);

export interface Position {
  shares: bigint;
  lastPrice: bigint;
  currentEpoch: bigint;
  lockedUntil: bigint;
  paused: boolean;
  stalled: boolean;
  claimableShares: bigint;
  claimableAssets: bigint;
  deposit: { epoch: bigint; assets: bigint };
  redeem: { epoch: bigint; shares: bigint };
  heldByHook: bigint;
}

export async function readPosition(client: PublicClient, config: ArcConfig, account: Address): Promise<Position> {
  const vault = config.vault;
  const abi = vaultPositionAbi;
  const [shares, lastPrice, currentEpoch, lockedUntil, paused, stalled, claims, deposit, redeem, heldByHook] = await Promise.all([
    client.readContract({ address: vault, abi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: vault, abi, functionName: "lastPrice" }),
    client.readContract({ address: vault, abi, functionName: "currentEpoch" }),
    client.readContract({ address: vault, abi, functionName: "lockedUntil", args: [account] }),
    client.readContract({ address: vault, abi, functionName: "requestsPaused" }),
    client.readContract({ address: vault, abi, functionName: "stalled" }),
    client.readContract({ address: vault, abi, functionName: "pendingClaims", args: [account] }),
    client.readContract({ address: vault, abi, functionName: "depositRequests", args: [account] }),
    client.readContract({ address: vault, abi, functionName: "redeemRequests", args: [account] }),
    config.hookExecutor
      ? client.readContract({ address: config.hookExecutor, abi: hookExecutorAbi, functionName: "claimable", args: [account] })
      : Promise.resolve(0n),
  ]);
  return {
    shares,
    lastPrice,
    currentEpoch,
    lockedUntil,
    paused,
    stalled,
    claimableShares: claims[0],
    claimableAssets: claims[1],
    deposit: { epoch: deposit[0], assets: deposit[1] },
    redeem: { epoch: redeem[0], shares: redeem[1] },
    heldByHook,
  };
}

export function shareValueUsdc(shares: bigint, priceE18: bigint): bigint {
  return (shares * priceE18) / PRICE_SCALE / SHARE_TO_USDC;
}

type SharesParse = { ok: true; units: bigint } | { ok: false; reason: string };

export function parseShareAmount(text: string, balance: bigint): SharesParse {
  const value = text.trim();
  if (value === "") return { ok: false, reason: "Enter a number of shares." };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(value)) return { ok: false, reason: "Use digits and at most one decimal point." };
  const fraction = value.split(".")[1] ?? "";
  if (fraction.length > SHARE_DECIMALS) return { ok: false, reason: `Shares have ${SHARE_DECIMALS} decimals. Use fewer decimal places.` };
  const units = parseUnits(value.startsWith(".") ? `0${value}` : value, SHARE_DECIMALS);
  if (units === 0n) return { ok: false, reason: "The amount must be above zero." };
  if (units > balance) return { ok: false, reason: "You hold fewer shares than that." };
  return { ok: true, units };
}

export type WithdrawStage = "none" | "waiting-for-close" | "ready-to-claim" | "partly-carried";

export function withdrawStage(position: Pick<Position, "redeem" | "currentEpoch" | "claimableAssets">): WithdrawStage {
  const { redeem, currentEpoch, claimableAssets } = position;
  if (redeem.shares > 0n && redeem.epoch >= currentEpoch) return claimableAssets > 0n ? "partly-carried" : "waiting-for-close";
  if (claimableAssets > 0n) return redeem.shares > 0n ? "partly-carried" : "ready-to-claim";
  if (redeem.shares > 0n) return "waiting-for-close";
  return "none";
}

export function lockupRemainingSeconds(lockedUntil: bigint, nowSeconds: number): number {
  const left = Number(lockedUntil) - nowSeconds;
  return left > 0 ? left : 0;
}

export function withdrawStepStatuses(stage: WithdrawStage): [StepStatus, StepStatus, StepStatus] {
  switch (stage) {
    case "none":
      return ["active", "waiting", "waiting"];
    case "waiting-for-close":
      return ["done", "active", "waiting"];
    case "partly-carried":
    case "ready-to-claim":
      return ["done", "done", "active"];
  }
}

export async function claimHeldDeposit(args: { publicClient: PublicClient; walletClient: WalletClient; config: ArcConfig; account: Address }): Promise<Hex> {
  const { publicClient, walletClient, config, account } = args;
  if (!config.hookExecutor) throw new Error("The hook executor is not configured.");
  const { request } = await publicClient.simulateContract({ account, address: config.hookExecutor, abi: hookExecutorAbi, functionName: "claim" });
  const hash = await walletClient.writeContract({ ...request, account: walletClient.account ?? account, chain: arcChain(config) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`The claim was mined but reverted (${hash}).`);
  return hash;
}

export type WithdrawAction = "request" | "cancel" | "claim-assets" | "claim-shares";

export async function runWithdrawAction(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  config: ArcConfig;
  account: Address;
  action: WithdrawAction;
  shares?: bigint;
  onSent?: (hash: Hex) => void;
}): Promise<Hex> {
  const { publicClient, walletClient, config, account, action, shares, onSent } = args;
  const base = { account, address: config.vault, abi: vaultPositionAbi } as const;
  const signer = walletClient.account ?? account;
  const chain = arcChain(config);
  const send = async (): Promise<Hex> => {
    switch (action) {
      case "request": {
        const { request } = await publicClient.simulateContract({ ...base, functionName: "requestRedeem", args: [shares ?? 0n, account] });
        return walletClient.writeContract({ ...request, account: signer, chain });
      }
      case "cancel": {
        const { request } = await publicClient.simulateContract({ ...base, functionName: "cancelRedeem" });
        return walletClient.writeContract({ ...request, account: signer, chain });
      }
      case "claim-assets": {
        const { request } = await publicClient.simulateContract({ ...base, functionName: "claimAssets", args: [account] });
        return walletClient.writeContract({ ...request, account: signer, chain });
      }
      case "claim-shares": {
        const { request } = await publicClient.simulateContract({ ...base, functionName: "claimShares", args: [account] });
        return walletClient.writeContract({ ...request, account: signer, chain });
      }
    }
  };
  const hash = await send();
  onSent?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`The transaction was mined but reverted (${hash}).`);
  return hash;
}
