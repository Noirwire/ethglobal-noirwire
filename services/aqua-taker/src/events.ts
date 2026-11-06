import { type FlowEvent, type HedgeOrder, flowEvent, fromBaseUnits } from "@noirwire/shared";
import { PRICE_DECIMALS } from "./band.js";

export type HedgeStatus = HedgeOrder["status"];

export interface AquaHedgeInput {
  strategyHash: string;
  maker: string;
  txHash?: string;
  sourceFillIds: string[];
  makerSellsBtc: boolean;
  size8: bigint;
  limitPriceE8: bigint;
  status: HedgeStatus;
  filledSize8: bigint;
  avgPriceE8?: bigint;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function aquaHedgeEvent(input: AquaHedgeInput): FlowEvent {
  return flowEvent.parse({
    kind: "hedge",
    at: input.updatedAt.toISOString(),
    order: {
      venue: "aqua",
      strategyHash: input.strategyHash,
      maker: input.maker,
      txHash: input.txHash,
      sourceFillIds: input.sourceFillIds,
      side: input.makerSellsBtc ? "sell" : "buy",
      size: input.size8.toString(),
      limitPrice: fromBaseUnits(input.limitPriceE8, PRICE_DECIMALS),
      status: input.status,
      filledSize: input.filledSize8.toString(),
      avgPrice: input.avgPriceE8 === undefined ? undefined : fromBaseUnits(input.avgPriceE8, PRICE_DECIMALS),
      error: input.error,
      createdAt: input.createdAt.toISOString(),
      updatedAt: input.updatedAt.toISOString(),
    },
  });
}

export function toNdjson(event: FlowEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function emitEvent(event: FlowEvent, write: (line: string) => unknown = (line) => process.stdout.write(line)): void {
  write(toNdjson(event));
}
