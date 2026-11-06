import type { Hex } from "viem";

export const CIRCLE_TESTNET = {
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
  messageV2: "0xbaC0179bB358A8936169a63408C8481D582390C4",
  hyperEvmCctpForwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
  hyperEvmCoreDepositWallet: "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206",
} as const satisfies Record<string, Hex>;

export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.network",
  usdc: "0x3600000000000000000000000000000000000000",
} as const satisfies { chainId: number; rpcUrl: string; usdc: Hex };

export const SOLANA_DEVNET = {
  rpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const;
