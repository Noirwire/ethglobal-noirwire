import { z } from "zod";
import { btc8, price, usdc6 } from "./units.ts";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const cloidHex = z.string().regex(/^0x[0-9a-fA-F]{32}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const isoTime = z.iso.datetime();

export const side = z.enum(["buy", "sell"]);

export const makerFill = z.object({
  fillId: z.string().min(1),
  market: z.string().min(1),
  makerSide: side,
  size: btc8,
  price,
  filledAt: isoTime,
});
export type MakerFill = z.infer<typeof makerFill>;

export const hedgeOrderStatus = z.enum(["pending", "sent", "filled", "partial", "rejected", "cancelled"]);

export const hedgeOrder = z.object({
  cloid: cloidHex.describe("Hyperliquid client order id"),
  sourceFillIds: z.array(z.string()).min(1),
  venue: z.enum(["hyperliquid", "aqua"]),
  side,
  size: btc8,
  limitPrice: price,
  status: hedgeOrderStatus,
  filledSize: btc8,
  avgPrice: price.optional(),
  venueOrderId: z.string().optional(),
  error: z.string().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type HedgeOrder = z.infer<typeof hedgeOrder>;

export const exposure = z.object({
  market: z.string(),
  makerPosition: btc8,
  hyperliquidPosition: btc8,
  aquaInventory: btc8,
  netResidual: btc8,
  asOf: isoTime,
});
export type Exposure = z.infer<typeof exposure>;

export const transferState = z.enum([
  "requested",
  "burned",
  "attested",
  "minted",
  "forwarded",
  "credited",
  "failed",
]);
export type TransferState = z.infer<typeof transferState>;

export const bridgeTransfer = z.object({
  transferId: z.string().min(1),
  route: z.enum(["arc-solana", "solana-arc", "arc-hypercore", "hypercore-arc"]),
  amount: usdc6,
  state: transferState,
  burnTx: z.string().optional(),
  attestation: z.string().optional(),
  mintTx: z.string().optional(),
  creditTx: z.string().optional(),
  attester: z.enum(["circle-iris", "local-test-attester"]),
  closeId: z.number().int().nonnegative().optional(),
  updatedAt: isoTime,
});
export type BridgeTransfer = z.infer<typeof bridgeTransfer>;

export const navSource = z.object({
  leg: z.enum(["arc-vault-cash", "solana-maker", "hyperliquid", "aqua", "in-transit"]),
  assets: usdc6,
  liabilities: usdc6,
  observedAt: isoTime,
  blockOrSlot: z.string().optional(),
  trust: z.enum(["onchain", "venue-api", "operator-supplied"]),
});
export type NavSource = z.infer<typeof navSource>;

export const navSnapshot = z.object({
  closeId: z.number().int().nonnegative(),
  totalAssets: usdc6,
  totalLiabilities: usdc6,
  netAssets: usdc6,
  sharePriceE18: z.string().regex(/^\d+$/),
  sources: z.array(navSource).min(1),
  inTransitTransferIds: z.array(z.string()),
  takenAt: isoTime,
});
export type NavSnapshot = z.infer<typeof navSnapshot>;

export const topUpIntent = z.object({
  intentId: hex32,
  closeId: z.number().int().nonnegative(),
  route: z.enum(["arc-hypercore", "hypercore-arc", "arc-solana", "solana-arc"]),
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
  chainId: z.number().int(),
  shareVault: evmAddress.optional(),
  usdc: evmAddress.optional(),
  creReceiver: evmAddress.optional(),
  hookExecutor: evmAddress.optional(),
  hedgeGuard: evmAddress.optional(),
});
export type ContractAddresses = z.infer<typeof contractAddresses>;
