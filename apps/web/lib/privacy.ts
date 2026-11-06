import type { FlowEvent, HedgeOrder, MakerFill } from "@noirwire/shared";

export const BUCKET_MS = 10_000;
export const PUBLISH_DELAY_MS = 20_000;
export const WINDOW_MS = 15 * 60_000;
export const ROUND_UNITS = 1_000_000n;

export type HedgeVenueName = "hyperliquid" | "aqua";

export interface PublicHedgeBucket {
  venue: HedgeVenueName;
  net: string;
  orders: number;
  rejected: number;
}

export interface PublicBucket {
  start: string;
  makerPosition: string | null;
  hyperliquidPosition: string | null;
  aquaInventory: string | null;
  residual: string | null;
  makerFlow: string;
  hedges: PublicHedgeBucket[];
}

export interface PublicAggregate {
  buckets: PublicBucket[];
  latencySeconds: number | null;
}

export function roundBtc8(units: bigint): bigint {
  const magnitude = units < 0n ? -units : units;
  const rounded = ((magnitude + ROUND_UNITS / 2n) / ROUND_UNITS) * ROUND_UNITS;
  return units < 0n ? -rounded : rounded;
}

export function bucketStartMs(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

export function publishedUntilMs(nowMs: number): number {
  return bucketStartMs(nowMs - PUBLISH_DELAY_MS);
}

export function isPublishable(bucketStart: number, nowMs: number): boolean {
  return bucketStart + BUCKET_MS <= publishedUntilMs(nowMs);
}

function signed(side: "buy" | "sell", size: string): bigint {
  return side === "buy" ? BigInt(size) : -BigInt(size);
}

function orderKey(order: HedgeOrder): string {
  return order.venue === "hyperliquid" ? `hl:${order.cloid}` : `aqua:${order.strategyHash}:${order.createdAt}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

interface Accumulator {
  makerFlow: bigint;
  hedges: Map<HedgeVenueName, { net: bigint; orders: number; rejected: number }>;
}

export function aggregate(events: FlowEvent[], nowMs: number): PublicAggregate {
  const end = publishedUntilMs(nowMs);
  const first = end - WINDOW_MS;

  const exposures: { at: number; exposure: Extract<FlowEvent, { kind: "exposure" }>["exposure"] }[] = [];
  const fills = new Map<string, MakerFill>();
  const orders = new Map<string, HedgeOrder>();
  for (const event of events) {
    if (event.kind === "exposure") exposures.push({ at: Date.parse(event.at), exposure: event.exposure });
    else if (event.kind === "fill") fills.set(event.fill.fillId, event.fill);
    else if (event.kind === "hedge") {
      const key = orderKey(event.order);
      const known = orders.get(key);
      if (!known || Date.parse(event.order.updatedAt) >= Date.parse(known.updatedAt)) orders.set(key, event.order);
    }
  }
  exposures.sort((a, b) => a.at - b.at);

  const accumulators = new Map<number, Accumulator>();
  const accumulatorFor = (start: number): Accumulator | null => {
    if (start < first || start >= end) return null;
    let acc = accumulators.get(start);
    if (!acc) {
      acc = { makerFlow: 0n, hedges: new Map() };
      accumulators.set(start, acc);
    }
    return acc;
  };

  for (const fill of fills.values()) {
    const acc = accumulatorFor(bucketStartMs(Date.parse(fill.filledAt)));
    if (acc) acc.makerFlow += signed(fill.makerSide, fill.size);
  }

  const latencies: number[] = [];
  for (const order of orders.values()) {
    const updated = Date.parse(order.updatedAt);
    const acc = accumulatorFor(bucketStartMs(updated));
    if (!acc) continue;
    const entry = acc.hedges.get(order.venue) ?? { net: 0n, orders: 0, rejected: 0 };
    entry.net += signed(order.side, order.filledSize);
    entry.orders += 1;
    if (order.status === "rejected") entry.rejected += 1;
    acc.hedges.set(order.venue, entry);

    if (BigInt(order.filledSize) > 0n) {
      const sources = order.sourceFillIds.flatMap((id) => {
        const fill = fills.get(id);
        return fill ? [Date.parse(fill.filledAt)] : [];
      });
      if (sources.length > 0) latencies.push(Math.max(0, updated - Math.min(...sources)) / 1000);
    }
  }

  const buckets: PublicBucket[] = [];
  let cursor = -1;
  for (let start = first; start < end; start += BUCKET_MS) {
    while (cursor + 1 < exposures.length && (exposures[cursor + 1]?.at ?? Infinity) < start + BUCKET_MS) cursor += 1;
    const exposure = cursor >= 0 ? exposures[cursor]?.exposure : undefined;
    const acc = accumulators.get(start);
    buckets.push({
      start: new Date(start).toISOString(),
      makerPosition: exposure ? roundBtc8(BigInt(exposure.makerPosition)).toString() : null,
      hyperliquidPosition: exposure ? roundBtc8(BigInt(exposure.hyperliquidPosition)).toString() : null,
      aquaInventory: exposure ? roundBtc8(BigInt(exposure.aquaInventory)).toString() : null,
      residual: exposure ? roundBtc8(BigInt(exposure.netResidual)).toString() : null,
      makerFlow: roundBtc8(acc?.makerFlow ?? 0n).toString(),
      hedges: [...(acc?.hedges.entries() ?? [])].map(([venue, entry]) => ({
        venue,
        net: roundBtc8(entry.net).toString(),
        orders: entry.orders,
        rejected: entry.rejected,
      })),
    });
  }

  const latency = median(latencies);
  return { buckets, latencySeconds: latency === null ? null : Math.round(latency) };
}
