import {
  BaseError,
  defineChain,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { ArcConfig } from "./config";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

export const vaultAbi = parseAbi([
  "function requestDeposit(uint256 assets, address receiver)",
  "function depositRequests(address user) view returns (uint64 epoch, uint192 assets)",
  "function pendingClaims(address user) view returns (uint256 shares, uint256 assets)",
  "function currentEpoch() view returns (uint64)",
  "function requestsPaused() view returns (bool)",
  "function stalled() view returns (bool)",
]);

export function arcChain(config: ArcConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: config.chainName,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(config.explorer ? { blockExplorers: { default: { name: "Arc explorer", url: config.explorer } } } : {}),
  });
}

export interface ArcState {
  balance: bigint;
  allowance: bigint;
  paused: boolean;
  stalled: boolean;
  currentEpoch: bigint;
  request: { epoch: bigint; assets: bigint };
  claimableShares: bigint;
}

export async function readArcState(client: PublicClient, config: ArcConfig, account: Address): Promise<ArcState> {
  const [balance, allowance, paused, stalled, currentEpoch, request, claims] = await Promise.all([
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "allowance", args: [account, config.vault] }),
    client.readContract({ address: config.vault, abi: vaultAbi, functionName: "requestsPaused" }),
    client.readContract({ address: config.vault, abi: vaultAbi, functionName: "stalled" }),
    client.readContract({ address: config.vault, abi: vaultAbi, functionName: "currentEpoch" }),
    client.readContract({ address: config.vault, abi: vaultAbi, functionName: "depositRequests", args: [account] }),
    client.readContract({ address: config.vault, abi: vaultAbi, functionName: "pendingClaims", args: [account] }),
  ]);
  return {
    balance,
    allowance,
    paused,
    stalled,
    currentEpoch,
    request: { epoch: request[0], assets: request[1] },
    claimableShares: claims[0],
  };
}

export type DepositStep = "approving" | "depositing";

export interface DepositResult {
  approveTx: Hex | null;
  depositTx: Hex;
  state: ArcState;
}

async function confirmed(client: PublicClient, hash: Hex, what: string): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} was mined but reverted (${hash}).`);
}

export async function depositToVault(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  config: ArcConfig;
  account: Address;
  assets: bigint;
  onStep?: (step: DepositStep, hash?: Hex) => void;
}): Promise<DepositResult> {
  const { publicClient, walletClient, config, account, assets, onStep } = args;
  const chain = arcChain(config);
  const signer = walletClient.account ?? account;

  const allowance = await publicClient.readContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, config.vault],
  });
  let approveTx: Hex | null = null;
  if (allowance < assets) {
    onStep?.("approving");
    approveTx = await walletClient.writeContract({
      account: signer,
      chain,
      address: config.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [config.vault, assets],
    });
    onStep?.("approving", approveTx);
    await confirmed(publicClient, approveTx, "The USDC approval");
  }

  onStep?.("depositing");
  const { request } = await publicClient.simulateContract({
    account,
    address: config.vault,
    abi: vaultAbi,
    functionName: "requestDeposit",
    args: [assets, account],
  });
  const depositTx = await walletClient.writeContract({ ...request, account: signer, chain });
  onStep?.("depositing", depositTx);
  await confirmed(publicClient, depositTx, "The deposit request");
  return { approveTx, depositTx, state: await readArcState(publicClient, config, account) };
}

const VAULT_ERRORS: Record<string, string> = {
  ShareVault__RequestsPaused: "The vault has paused new requests after a large price move. Try again after the next close.",
  ShareVault__StaleHalt: "The vault has not closed an epoch recently, so new deposits are halted until it does.",
  ShareVault__ZeroAmount: "The amount must be above zero.",
  ERC20InsufficientBalance: "Your wallet holds less USDC than this amount. Lower the amount or add USDC.",
  ERC20InsufficientAllowance: "The approval did not cover this amount. Run the deposit again to approve it.",
};

export function explainWalletError(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  const text = error instanceof Error ? error.message : String(error);
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(text)) {
    return "You rejected the request in your wallet. Nothing was sent. Confirm it in the wallet to continue.";
  }
  if (code === 4902 || /unrecognized chain|chain.*not added/i.test(text)) {
    return "Your wallet does not know this network yet. Add it in the wallet, then try again.";
  }
  if (/chain mismatch|does not match the target chain/i.test(text)) {
    return "Your wallet is on a different network. Switch it to the Arc network and try again.";
  }
  if (error instanceof BaseError) {
    const named = error.walk((cause) => typeof (cause as { data?: { errorName?: string } }).data?.errorName === "string") as
      | { data: { errorName: string } }
      | null;
    const known = named ? VAULT_ERRORS[named.data.errorName] : undefined;
    if (known) return known;
    if (/insufficient funds/i.test(error.details ?? error.shortMessage)) {
      return "Your wallet has too little USDC to pay the network fee. Arc uses USDC for gas, so add some and try again.";
    }
    return error.shortMessage;
  }
  return text.split("\n")[0] || "The wallet request failed.";
}
