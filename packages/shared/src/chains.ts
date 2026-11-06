import type { TransferRoute } from "./schemas.ts";

export const CCTP_DOMAINS = {
  ethereum: 0,
  arbitrum: 3,
  solana: 5,
  base: 6,
  hyperEvm: 19,
  arc: 26,
} as const;

export type RouteChain = "arc" | "solana" | "hypercore" | "ethereum" | "base" | "arbitrum";

export const CHAIN_CCTP_DOMAIN: Record<RouteChain, number> = {
  arc: CCTP_DOMAINS.arc,
  solana: CCTP_DOMAINS.solana,
  hypercore: CCTP_DOMAINS.hyperEvm,
  ethereum: CCTP_DOMAINS.ethereum,
  base: CCTP_DOMAINS.base,
  arbitrum: CCTP_DOMAINS.arbitrum,
};

export const ROUTE_ENDPOINTS: Record<TransferRoute, { from: RouteChain; to: RouteChain }> = {
  "arc-solana": { from: "arc", to: "solana" },
  "solana-arc": { from: "solana", to: "arc" },
  "ethereum-arc": { from: "ethereum", to: "arc" },
  "base-arc": { from: "base", to: "arc" },
  "arbitrum-arc": { from: "arbitrum", to: "arc" },
  "arc-hypercore": { from: "arc", to: "hypercore" },
  "hypercore-arc": { from: "hypercore", to: "arc" },
  "solana-hypercore": { from: "solana", to: "hypercore" },
  "hypercore-solana": { from: "hypercore", to: "solana" },
};

export const INTENT_ROUTES = [
  "arc-hypercore",
  "hypercore-arc",
  "arc-solana",
  "solana-arc",
  "solana-hypercore",
  "hypercore-solana",
] as const satisfies readonly TransferRoute[];

export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

export const NETWORKS = {
  arcTestnet: {
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorer: "https://explorer.testnet.arc.io",
    cctpDomain: CCTP_DOMAINS.arc,
  },
  hyperEvmTestnet: {
    chainId: 998,
    rpcUrl: "https://rpc.hyperliquid-testnet.xyz/evm",
    cctpDomain: CCTP_DOMAINS.hyperEvm,
  },
  hyperliquidTestnetApi: {
    infoUrl: "https://api.hyperliquid-testnet.xyz/info",
    exchangeUrl: "https://api.hyperliquid-testnet.xyz/exchange",
  },
  solanaDevnet: {
    rpcUrl: "https://api.devnet.solana.com",
    cctpDomain: CCTP_DOMAINS.solana,
  },
} as const;

export const CCTP_TESTNET_CONTRACTS = {
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
} as const;

export const EVM_FUNDING_SOURCES = {
  ethereumSepolia: {
    label: "Ethereum Sepolia",
    chainId: 11155111,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    cctpDomain: CCTP_DOMAINS.ethereum,
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  baseSepolia: {
    label: "Base Sepolia",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    cctpDomain: CCTP_DOMAINS.base,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  arbitrumSepolia: {
    label: "Arbitrum Sepolia",
    chainId: 421614,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    cctpDomain: CCTP_DOMAINS.arbitrum,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  },
} as const;

export type EvmFundingSourceId = keyof typeof EVM_FUNDING_SOURCES;

export const LOCAL_NETWORKS = {
  arcLocal: { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", cctpDomain: CCTP_DOMAINS.arc },
  aquaFork: { chainId: 42161, rpcUrl: "http://127.0.0.1:8546", cctpDomain: CCTP_DOMAINS.arbitrum },
  solanaLocal: { rpcUrl: "http://127.0.0.1:8899", cctpDomain: CCTP_DOMAINS.solana },
} as const;

export const AQUA = {
  registry: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
  swapVmRouter: "0x111111338c5091e8440b67b168bae16a668ac0de",
} as const;

export const ARBITRUM_TOKENS = {
  wbtc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  chainlinkBtcUsd: "0x6ce185860a4963106506C203335A2910413708e9",
} as const;

export const BTC_MARKET_ID = "NBTC-PERP";
