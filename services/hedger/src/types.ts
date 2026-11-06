import type { MakerFill, Side } from "@noirwire/shared";

export type { Side };

export type HedgeStatus = "hedged" | "lagging" | "blind" | "halted";

export interface VenueSpec {
  coin: string;
  assetIndex: number;
  szDecimals: number;
  minNotional6: bigint;
  maxLeverage: number;
}

export interface PlaceIocRequest {
  cloid: string;
  side: Side;
  size8: bigint;
  limitPx8: bigint;
  reduceOnly: boolean;
}

export type PlaceOutcome = "filled" | "partial" | "unfilled" | "rejected";

export interface PlaceResult {
  outcome: PlaceOutcome;
  filled8: bigint;
  avgPx8?: bigint;
  reason?: string;
}

export type OrderState = "unknown" | "open" | "filled" | "cancelled" | "rejected";

export interface OrderStatus {
  state: OrderState;
  filled8: bigint;
  avgPx8?: bigint;
  reason?: string;
}

export interface VenueFill {
  id: string;
  cloid?: string;
  side: Side;
  size8: bigint;
  px8: bigint;
  time: number;
}

export interface AccountState {
  accountValue6: bigint;
  totalMarginUsed6: bigint;
  withdrawable6: bigint;
  markPx8: bigint;
}

export interface HedgeVenue {
  readonly spec: VenueSpec;
  placeIoc(request: PlaceIocRequest): Promise<PlaceResult>;
  cancelByCloid(cloid: string): Promise<void>;
  orderStatusByCloid(cloid: string): Promise<OrderStatus>;
  fillsSince(timeMs: number): Promise<VenueFill[]>;
  position(): Promise<bigint>;
  accountState(): Promise<AccountState>;
}

export class FillSourceConfigError extends Error {}

export interface FillBatch {
  fills: MakerFill[];
  cursor: string;
  makerPosition8?: bigint;
}

export interface FillSource {
  readonly reportsPosition?: boolean;
  poll(): Promise<FillBatch>;
  commit(cursor: string): Promise<void>;
}

export interface AquaBand {
  direction: Side;
  maxSize8: bigint;
  minPx8: bigint;
  maxPx8: bigint;
  expiresAt: number;
}

export interface AquaOutlet {
  setBand(band: AquaBand | null): Promise<void>;
  inventory(): Promise<bigint>;
}

export interface ReferencePrice {
  px8: bigint;
  at: number;
}

export interface ReferencePriceSource {
  get(): Promise<ReferencePrice>;
}

export type Clock = () => number;
