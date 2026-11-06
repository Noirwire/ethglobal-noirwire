import type { HedgeOrder } from "@noirwire/shared";
import type { JournalOrder } from "./journal.ts";
import { priceToDecimal } from "./numbers.ts";
import type { VenueSpec } from "./types.ts";

const REBALANCE_SOURCE = "rebalance";

export function orderStatusFor(order: JournalOrder): HedgeOrder["status"] {
  if (!order.settled) return "unresolved";
  switch (order.final) {
    case "filled":
      return "filled";
    case "partial":
      return "partial";
    case "rejected":
      return "rejected";
    default:
      return order.filled8 > 0n ? "partial" : "cancelled";
  }
}

export function toHedgeOrderEvent(
  order: JournalOrder,
  spec: VenueSpec,
  status: HedgeOrder["status"],
  now: number,
): HedgeOrder {
  return {
    venue: "hyperliquid",
    cloid: order.cloid,
    coin: spec.coin,
    assetIndex: spec.assetIndex,
    reduceOnly: order.reduceOnly,
    tif: "Ioc",
    sourceFillIds: order.sourceFillIds.length > 0 ? order.sourceFillIds : [REBALANCE_SOURCE],
    side: order.side,
    size: order.size8.toString(),
    limitPrice: priceToDecimal(order.limitPx8),
    status,
    filledSize: order.filled8.toString(),
    avgPrice: order.avgPx8 ? priceToDecimal(order.avgPx8) : undefined,
    error: order.reason,
    createdAt: new Date(order.intentAt).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}
