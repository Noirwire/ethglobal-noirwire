import { EVM_FUNDING_SOURCES, NETWORKS } from "@noirwire/shared";

export type Chain = "arc" | "solana" | "hypercore" | "ethereum" | "base" | "arbitrum";

export const CHAIN_LABEL: Record<Chain, string> = {
  arc: "Arc",
  solana: "Solana",
  hypercore: "HyperCore",
  ethereum: "Ethereum Sepolia",
  base: "Base Sepolia",
  arbitrum: "Arbitrum Sepolia",
};

export function txUrl(chain: Chain, hash: string): string {
  switch (chain) {
    case "ethereum":
      return `${EVM_FUNDING_SOURCES.ethereumSepolia.explorer}/tx/${hash}`;
    case "base":
      return `${EVM_FUNDING_SOURCES.baseSepolia.explorer}/tx/${hash}`;
    case "arbitrum":
      return `${EVM_FUNDING_SOURCES.arbitrumSepolia.explorer}/tx/${hash}`;
    case "arc":
      return `${NETWORKS.arcTestnet.explorer}/tx/${hash}`;
    case "solana":
      return `https://explorer.solana.com/tx/${hash}?cluster=devnet`;
    case "hypercore":
      return `https://app.hyperliquid-testnet.xyz/explorer/tx/${hash}`;
  }
}

export function addressUrl(account: string): string | null {
  const [prefix, ...rest] = account.split(":");
  const id = rest.join(":");
  if (!id) return null;
  if (prefix === "arc" && /^0x[0-9a-fA-F]{40}$/.test(id)) return `${NETWORKS.arcTestnet.explorer}/address/${id}`;
  if (prefix === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) {
    return `https://explorer.solana.com/address/${id}?cluster=devnet`;
  }
  return null;
}

export function shortHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}
