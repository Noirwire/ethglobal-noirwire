import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BTC_DECIMALS, hedgeSideFor, price, toBaseUnits, type MakerFill } from "@noirwire/shared";
import { z } from "zod";
import { FillSourceConfigError, type FillBatch, type FillSource } from "../types.ts";

const TAPE_LIMIT = 500;
const NO_SEQUENCE = -1;

const tag = z.string().regex(/^\d+$/);

const tapeFill = z.object({
  market: z.string().min(1),
  price,
  size: price,
  takerSide: z.enum(["buy", "sell"]),
  takerTag: tag,
  makerTag: tag,
  timestampMs: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
});

const tapeResponse = z.object({
  network: z.string(),
  simulated: z.boolean(),
  fills: z.array(tapeFill),
});

const positionResponse = z.object({
  market: z.string().min(1),
  size: z.string().regex(/^-?\d+(\.\d+)?$/),
  observedAt: z.string(),
});

export type TapeFill = z.infer<typeof tapeFill>;

export function parseTapeResponse(body: unknown): TapeFill[] {
  return tapeResponse.parse(body).fills;
}

export function parsePositionResponse(body: unknown): { market: string; position8: bigint } {
  const parsed = positionResponse.parse(body);
  return { market: parsed.market, position8: toBaseUnits(parsed.size, BTC_DECIMALS) };
}

export function mapTapeFill(row: TapeFill, houseMakerTag: string | undefined, market: string): MakerFill | null {
  if (houseMakerTag === undefined || row.makerTag !== houseMakerTag) return null;
  if (row.market !== market) return null;
  return {
    fillId: `${row.market}:${row.sequence}`,
    market: row.market,
    makerSide: hedgeSideFor(row.takerSide),
    size: toBaseUnits(row.size, BTC_DECIMALS).toString(),
    price: row.price,
    filledAt: new Date(row.timestampMs).toISOString(),
  };
}

export function mapTapeBatch(
  rows: TapeFill[],
  market: string,
  houseMakerTag: string | undefined,
  previousCursor: string,
): { fills: MakerFill[]; cursor: string } {
  const lastSeen = previousCursor === "" ? NO_SEQUENCE : Number(previousCursor);
  const fresh = rows.filter((row) => row.market === market && row.sequence > lastSeen).sort((a, b) => a.sequence - b.sequence);
  const fills: MakerFill[] = [];
  for (const row of fresh) {
    const fill = mapTapeFill(row, houseMakerTag, market);
    if (fill) fills.push(fill);
  }
  const newest = fresh.at(-1);
  return { fills, cursor: newest ? String(newest.sequence) : previousCursor };
}

interface TapeFillSourceOptions {
  bookApiUrl: string;
  market: string;
  cursorFile: string;
  houseMakerTag?: string;
  fetchImpl?: typeof fetch;
}

export class TapeFillSource implements FillSource {
  readonly reportsPosition = true;
  private cursor: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TapeFillSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cursor = loadCursor(options.cursorFile);
  }

  async poll(): Promise<FillBatch> {
    const tape = parseTapeResponse(
      await this.getJson("/v1/tape", { market: this.options.market, limit: String(TAPE_LIMIT) }),
    );
    const position = parsePositionResponse(await this.getJson("/v1/maker/position", { market: this.options.market }));
    if (position.market !== this.options.market) {
      throw new Error(`maker position is for ${position.market}, expected ${this.options.market}`);
    }
    const { fills, cursor } = mapTapeBatch(tape, this.options.market, this.options.houseMakerTag, this.cursor);
    return { fills, cursor, makerPosition8: position.position8 };
  }

  async commit(cursor: string): Promise<void> {
    this.cursor = cursor;
    mkdirSync(dirname(this.options.cursorFile), { recursive: true });
    writeFileSync(this.options.cursorFile, JSON.stringify({ cursor }));
  }

  private async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.options.bookApiUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url);
    if (response.status === 404 || response.status === 400) {
      throw new FillSourceConfigError(`${path} answered ${response.status}: check BOOK_API_URL and BOOK_MARKET`);
    }
    if (!response.ok) throw new Error(`${path} request failed with ${response.status}`);
    return response.json();
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
