import { z } from "zod";
import { btc8, price, signedBtc8, signedUsdc6, usdc6 } from "./units.ts";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const cloidHex = z.string().regex(/^0x[0-9a-fA-F]{32}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const isoTime = z.iso.datetime();

export const side = z.enum(["buy", "sell"]);
export type Side = z.infer<typeof side>;

export const makerFill = z.object({
  fillId: z.string().min(1),
  market: z.string().min(1),
  makerSide: side,
  size: btc8,
  price,
  filledAt: isoTime,
});
export type MakerFill = z.infer<typeof makerFill>;

export function hedgeSideFor(makerSide: Side): Side {
  return makerSide === "buy" ? "sell" : "buy";
}

export const hedgeOrderStatus = z.enum(["pending", "sent", "filled", "partial", "rejected", "cancelled", "unresolved"]);

const hedgeOrderCommon = {
  sourceFillIds: z.array(z.string()).min(1),
  side,
  size: btc8,
  limitPrice: price,
  status: hedgeOrderStatus,
  filledSize: btc8,
  avgPrice: price.optional(),
  error: z.string().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
};

export const hyperliquidHedgeOrder = z.object({
  venue: z.literal("hyperliquid"),
  cloid: cloidHex.describe("Hyperliquid client order id, 16 bytes"),
  coin: z.string().min(1),
  assetIndex: z.number().int().nonnegative(),
  reduceOnly: z.boolean(),
  tif: z.enum(["Ioc", "Gtc", "Alo"]),
  venueOrderId: z.string().optional(),
  ...hedgeOrderCommon,
});

export const aquaHedgeOrder = z.object({
  venue: z.literal("aqua"),
  strategyHash: hex32,
  maker: evmAddress,
  txHash: hex32.optional(),
  ...hedgeOrderCommon,
});

export const hedgeOrder = z.discriminatedUnion("venue", [hyperliquidHedgeOrder, aquaHedgeOrder]);
export type HedgeOrder = z.infer<typeof hedgeOrder>;

export const exposure = z.object({
  market: z.string(),
  makerPosition: signedBtc8,
  hyperliquidPosition: signedBtc8,
  aquaInventory: signedBtc8,
  netResidual: signedBtc8,
  asOf: isoTime,
});
export type Exposure = z.infer<typeof exposure>;

export const transferRoute = z.enum([
  "arc-solana",
  "solana-arc",
  "arc-hypercore",
  "hypercore-arc",
  "solana-hypercore",
  "hypercore-solana",
]);
export type TransferRoute = z.infer<typeof transferRoute>;

export const transferState = z.enum([
  "requested",
  "burned",
  "attested",
  "minted",
  "hook-executed",
  "vault-credited",
  "claimable",
  "forwarded",
  "credited",
  "stuck",
  "failed",
]);
export type TransferState = z.infer<typeof transferState>;

export const SETTLED_TRANSFER_STATES: ReadonlySet<TransferState> = new Set([
  "vault-credited",
  "claimable",
  "credited",
  "failed",
]);

export const bridgeTransfer = z.object({
  transferId: z.string().min(1),
  route: transferRoute,
  sourceDomain: z.number().int().nonnegative(),
  destinationDomain: z.number().int().nonnegative(),
  grossAmount: usdc6,
  maxFee: usdc6,
  feeExecuted: usdc6.optional(),
  netMinted: usdc6.optional(),
  beneficiary: z.string().optional(),
  state: transferState,
  burnTx: z.string().optional(),
  messageHash: hex32.optional(),
  cctpNonce: hex32.optional(),
  attestation: z.string().optional(),
  mintTx: z.string().optional(),
  creditTx: z.string().optional(),
  attester: z.enum(["circle-iris", "local-test-attester"]),
  closeId: z.number().int().nonnegative().optional(),
  released: z.boolean().optional(),
  error: z.string().optional(),
  updatedAt: isoTime,
});
export type BridgeTransfer = z.infer<typeof bridgeTransfer>;

export const navLeg = z.enum(["arc-vault-cash", "solana-maker", "hyperliquid", "aqua", "in-transit"]);
export type NavLeg = z.infer<typeof navLeg>;

export const NAV_LEG_CODES: Record<NavLeg, number> = {
  "arc-vault-cash": 0,
  "solana-maker": 1,
  hyperliquid: 2,
  aqua: 3,
  "in-transit": 4,
};

export const trustLabel = z.enum(["onchain", "venue-api", "operator-supplied"]);
export type TrustLabel = z.infer<typeof trustLabel>;

export const TRUST_CODES: Record<TrustLabel, number> = {
  onchain: 0,
  "venue-api": 1,
  "operator-supplied": 2,
};

export const navSource = z.object({
  leg: navLeg,
  account: z.string().min(1),
  assets: usdc6,
  liabilities: usdc6,
  unrealizedPnl: signedUsdc6.optional(),
  btcPosition: signedBtc8.optional(),
  valuationPrice: price.optional(),
  observedAt: isoTime,
  blockOrSlot: z.string().optional(),
  trust: trustLabel,
});
export type NavSource = z.infer<typeof navSource>;

export const navSnapshot = z.object({
  closeId: z.number().int().nonnegative(),
  totalAssets: usdc6,
  totalLiabilities: usdc6,
  netAssets: usdc6,
  shareSupply: z.string().regex(/^\d+$/).describe("Share supply at close, 18 decimals"),
  sharePriceE18: z.string().regex(/^\d+$/).describe("USD value of one whole share, scaled by 1e18"),
  sources: z.array(navSource).min(1),
  sourcesHash: hex32,
  inTransitTransferIds: z.array(z.string()),
  takenAt: isoTime,
});
export type NavSnapshot = z.infer<typeof navSnapshot>;

export const topUpIntent = z.object({
  intentId: hex32,
  closeId: z.number().int().nonnegative(),
  route: transferRoute,
  amount: usdc6,
  reason: z.enum(["margin-low", "margin-urgent", "surplus-return", "solana-rebalance"]),
  marginRatioBps: z.number().int().nonnegative(),
});
export type TopUpIntent = z.infer<typeof topUpIntent>;

export const flowEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fill"), at: isoTime, fill: makerFill }),
  z.object({ kind: z.literal("hedge"), at: isoTime, order: hedgeOrder }),
  z.object({ kind: z.literal("exposure"), at: isoTime, exposure }),
  z.object({ kind: z.literal("transfer"), at: isoTime, transfer: bridgeTransfer }),
  z.object({ kind: z.literal("nav"), at: isoTime, snapshot: navSnapshot }),
  z.object({ kind: z.literal("intent"), at: isoTime, intent: topUpIntent }),
]);
export type FlowEvent = z.infer<typeof flowEvent>;

export const contractAddresses = z.object({
  network: z.enum(["arc-local", "arc-testnet", "aqua-fork"]),
  chainId: z.number().int(),
  usdc: evmAddress,
  shareVault: evmAddress.optional(),
  navReceiver: evmAddress.optional(),
  hookExecutor: evmAddress.optional(),
  messageTransmitterV2: evmAddress.optional(),
  tokenMessengerV2: evmAddress.optional(),
  creForwarder: evmAddress.optional(),
  hedgeGuard: evmAddress.optional(),
});
export type ContractAddresses = z.infer<typeof contractAddresses>;
