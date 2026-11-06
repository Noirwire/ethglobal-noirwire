import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hedgeSideFor, toBaseUnits, type MakerFill } from "@noirwire/shared";
import { z } from "zod";
import type { FillBatch, FillSource } from "../types.ts";

const TAPE_SIDE_IS_TAKER_SIDE = true;

const decimalLike = z.union([z.string(), z.number()]).transform((value) =>
  typeof value === "number" ? value.toFixed(8).replace(/\.?0+$/, "") : value,
);

export const tapeRow = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  market: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  size: decimalLike,
  price: decimalLike,
  ts: z.union([z.number(), z.string()]),
  maker: z.boolean(),
});
export type TapeRow = z.infer<typeof tapeRow>;

const tapeResponse = z.union([
  z.array(z.unknown()),
  z.object({ rows: z.array(z.unknown()), cursor: z.union([z.string(), z.number()]).optional() }),
]);

function toIso(ts: number | string): string {
  const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return date.toISOString();
}

export function mapTapeRow(raw: unknown, expectedMarket: string): MakerFill | null {
  const row = tapeRow.parse(raw);
  if (!row.maker) return null;
  if (row.market !== expectedMarket) return null;
  const makerSide = TAPE_SIDE_IS_TAKER_SIDE ? hedgeSideFor(row.side) : row.side;
  return {
    fillId: row.id,
    market: row.market,
    makerSide,
    size: toBaseUnits(row.size, 8).toString(),
    price: row.price,
    filledAt: toIso(row.ts),
  };
}

export function mapTapeResponse(
  body: unknown,
  market: string,
  previousCursor: string,
): FillBatch {
  const parsed = tapeResponse.parse(body);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  const fills: MakerFill[] = [];
  let lastId = previousCursor;
  for (const raw of rows) {
    const fill = mapTapeRow(raw, market);
    const id = tapeRow.shape.id.safeParse((raw as { id?: unknown }).id);
    if (id.success) lastId = id.data;
    if (fill) fills.push(fill);
  }
  const cursor = !Array.isArray(parsed) && parsed.cursor !== undefined ? String(parsed.cursor) : lastId;
  return { fills, cursor };
}

export interface TapeFillSourceOptions {
  bookApiUrl: string;
  market: string;
  cursorFile: string;
  fetchImpl?: typeof fetch;
}

export class TapeFillSource implements FillSource {
  private cursor: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TapeFillSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cursor = loadCursor(options.cursorFile);
  }

  async poll(): Promise<FillBatch> {
    const url = new URL("/v1/tape", this.options.bookApiUrl);
    url.searchParams.set("market", this.options.market);
    url.searchParams.set("since", this.cursor);
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`tape request failed with ${response.status}`);
    return mapTapeResponse(await response.json(), this.options.market, this.cursor);
  }

  async commit(cursor: string): Promise<void> {
    this.cursor = cursor;
    mkdirSync(dirname(this.options.cursorFile), { recursive: true });
    writeFileSync(this.options.cursorFile, JSON.stringify({ cursor }));
  }
}

function loadCursor(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const parsed = z.object({ cursor: z.string() }).parse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.cursor;
  } catch {
    return "";
  }
}
