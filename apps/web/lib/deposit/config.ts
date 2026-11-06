import { NETWORKS } from "@noirwire/shared";
import { isAddress, type Address } from "viem";

const ARC_TESTNET_USDC: Address = "0x3600000000000000000000000000000000000000";

export const ARC_NATIVE_CURRENCY = { name: "USDC", symbol: "USDC", decimals: 18 } as const;

export interface ArcConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  vault: Address;
  usdc: Address;
  hookExecutor: Address | null;
  explorer: string | null;
}

type ArcConfigResult = { ok: true; config: ArcConfig } | { ok: false; reason: string };

interface PublicEnv {
  chainId?: string;
  rpcUrl?: string;
  vault?: string;
  usdc?: string;
  hookExecutor?: string;
}

export function readPublicEnv(): PublicEnv {
  return {
    chainId: process.env.NEXT_PUBLIC_ARC_CHAIN_ID,
    rpcUrl: process.env.NEXT_PUBLIC_ARC_RPC_URL,
    vault: process.env.NEXT_PUBLIC_SHARE_VAULT_ADDRESS,
    usdc: process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS,
    hookExecutor: process.env.NEXT_PUBLIC_HOOK_EXECUTOR_ADDRESS,
  };
}

export function parseArcConfig(env: PublicEnv): ArcConfigResult {
  const chainId = env.chainId?.trim() ? Number(env.chainId.trim()) : NETWORKS.arcTestnet.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0) return { ok: false, reason: "NEXT_PUBLIC_ARC_CHAIN_ID is not a chain id" };
  const vault = env.vault?.trim();
  if (!vault) return { ok: false, reason: "Arc deposits are not configured: NEXT_PUBLIC_SHARE_VAULT_ADDRESS is not set" };
  if (!isAddress(vault)) return { ok: false, reason: "NEXT_PUBLIC_SHARE_VAULT_ADDRESS is not an address" };
  const usdc = env.usdc?.trim() || ARC_TESTNET_USDC;
  if (!isAddress(usdc)) return { ok: false, reason: "NEXT_PUBLIC_ARC_USDC_ADDRESS is not an address" };
  const hookText = env.hookExecutor?.trim();
  const hookExecutor = hookText ? (isAddress(hookText) ? hookText : undefined) : null;
  if (hookExecutor === undefined) return { ok: false, reason: "NEXT_PUBLIC_HOOK_EXECUTOR_ADDRESS is not an address" };
  const isArcTestnet =chainId === NETWORKS.arcTestnet.chainId;
  return {
    ok: true,
    config: {
      chainId,
      chainName: isArcTestnet ? "Arc Testnet" : `Arc (chain ${chainId})`,
      rpcUrl: env.rpcUrl?.trim() || NETWORKS.arcTestnet.rpcUrl,
      vault,
      usdc,
      hookExecutor,
      explorer: isArcTestnet ? NETWORKS.arcTestnet.explorer : null,
    },
  };
}
