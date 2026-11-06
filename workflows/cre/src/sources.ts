import { z } from "zod";
import { parseDecimalToUnits } from "./nav.ts";
import { bridgeTransfer, type BridgeTransfer } from "./shared.ts";

const unsigned = z.string().regex(/^\d+$/);
const isoTime = z.iso.datetime();

const makerEquityBody = z.object({ equityUsdc6: unsigned, observedAt: isoTime });
const aquaInventoryBody = z.object({ usdc6: unsigned, wbtcE8: unsigned, observedAt: isoTime });
const hyperliquidBody = z.object({
  marginSummary: z.object({ accountValue: z.string(), totalMarginUsed: z.string() }),
  time: z.number(),
});

export interface MakerEquity {
  equityUsdc6: bigint;
  observedAtMs: number;
}

export interface AquaInventory {
  usdc6: bigint;
  wbtcE8: bigint;
  observedAtMs: number;
}

export interface HyperliquidAccount {
  accountValueUsdc6: bigint;
  marginUsedUsdc6: bigint;
  observedAtMs: number;
}

export function parseMakerEquity(text: string): MakerEquity {
  const body = makerEquityBody.parse(JSON.parse(text));
  return { equityUsdc6: BigInt(body.equityUsdc6), observedAtMs: Date.parse(body.observedAt) };
}

export function parseAquaInventory(text: string): AquaInventory {
  const body = aquaInventoryBody.parse(JSON.parse(text));
  return { usdc6: BigInt(body.usdc6), wbtcE8: BigInt(body.wbtcE8), observedAtMs: Date.parse(body.observedAt) };
}

export function parseHyperliquid(text: string): HyperliquidAccount {
  const body = hyperliquidBody.parse(JSON.parse(text));
  return {
    accountValueUsdc6: parseDecimalToUnits(body.marginSummary.accountValue, 6),
    marginUsedUsdc6: parseDecimalToUnits(body.marginSummary.totalMarginUsed, 6),
    observedAtMs: body.time,
  };
}

export function parseTransfers(text: string): BridgeTransfer[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("transfers response is not an array");
  return raw.map((item) => bridgeTransfer.parse(item));
}
