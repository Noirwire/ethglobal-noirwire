import type { Hex } from "viem";

export const CIRCLE_TESTNET = {
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  hyperEvmCctpForwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
} as const satisfies Record<string, Hex>;

export const ARC_TESTNET_USDC: Hex = "0x3600000000000000000000000000000000000000";

export const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
