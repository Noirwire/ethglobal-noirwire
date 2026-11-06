export const CCTP_DOMAINS = {
  ethereum: 0,
  arbitrum: 3,
  solana: 5,
  base: 6,
  hyperEvm: 19,
  arc: 26,
} as const;

export type CctpDomain = (typeof CCTP_DOMAINS)[keyof typeof CCTP_DOMAINS];

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
