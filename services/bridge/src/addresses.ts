import { CCTP_TESTNET_CONTRACTS } from "@noirwire/shared";
import type { Hex } from "viem";

export const CIRCLE_TESTNET = {
  ...CCTP_TESTNET_CONTRACTS,
  hyperEvmCctpForwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
} as const satisfies Record<string, Hex>;

export const CORE_DEPOSIT_WALLET_TESTNET: Hex = "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206";

export const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
