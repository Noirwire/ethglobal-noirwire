import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makerFill } from "@noirwire/shared";
import { FillSourceConfigError } from "../src/types.ts";
import { MemoryJournalStore } from "../src/journal.ts";
import {
  mapTapeBatch,
  mapTapeFill,
  parsePositionResponse,
  parseTapeResponse,
  TapeFillSource,
  type TapeFill,
} from "../src/sources/tape.ts";
import { makeHarness } from "./harness.ts";
import { HedgeController } from "../src/controller.ts";
import { EventBus } from "../src/events.ts";
import { Journal } from "../src/journal.ts";
import { MockVenue } from "../src/venue/mock-venue.ts";

const SCRATCH = join(import.meta.dirname, "..", ".test-tmp", "tape");
const HOUSE = "9001";
const MARKET = "NBTC-PERP";

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function wireRow(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    market: MARKET,
    price: "75351.0",
    size: "0.0012",
    takerSide: "buy",
    takerTag: "77",
    makerTag: HOUSE,
    timestampMs: 1_800_000_000_000 + sequence,
    sequence,
    ...overrides,
  };
}

function tapeBody(rows: unknown[]) {
  return { network: "devnet", simulated: true, fills: rows };
}

interface FakeVenueApi {
  rows: unknown[];
  position: string;
  tapeStatus: number;
  positionStatus: number;
  requested: string[];
  networkDown: boolean;
}

function fakeApi(): { api: FakeVenueApi; fetchImpl: typeof fetch } {
  const api: FakeVenueApi = {
    rows: [],
    position: "-0.0860",
    tapeStatus: 200,
    positionStatus: 200,
    requested: [],
    networkDown: false,
  };
  const fetchImpl = (async (input: URL | string) => {
    const url = new URL(String(input));
    api.requested.push(`${url.pathname}${url.search}`);
    if (api.networkDown) throw new TypeError("fetch failed");
    if (url.pathname === "/v1/tape") {
      return new Response(JSON.stringify(api.tapeStatus === 200 ? tapeBody(api.rows) : { error: "x" }), {
        status: api.tapeStatus,
      });
    }
    const body = { market: MARKET, size: api.position, observedAt: "2026-11-06T08:00:00.000Z" };
    return new Response(JSON.stringify(api.positionStatus === 200 ? body : { error: "x" }), {
      status: api.positionStatus,
    });
  }) as typeof fetch;
  return { api, fetchImpl };
}

function source(fetchImpl: typeof fetch, cursorFile: string, houseMakerTag: string | null = HOUSE) {
  return new TapeFillSource({
    bookApiUrl: "http://venue.test",
    market: MARKET,
    cursorFile,
    houseMakerTag: houseMakerTag ?? undefined,
    fetchImpl,
  });
}

describe("tape parsing", () => {
  it("parses the venue response shape", () => {
    const rows = parseTapeResponse(tapeBody([wireRow(5)]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 5, makerTag: HOUSE, takerSide: "buy", price: "75351.0" });
  });

  it("rejects the old guessed shapes and malformed rows", () => {
    expect(() => parseTapeResponse([wireRow(1)])).toThrow();
    expect(() => parseTapeResponse({ rows: [wireRow(1)], cursor: "1" })).toThrow();
    expect(() => parseTapeResponse(tapeBody([{ id: "x", maker: true, side: "buy" }]))).toThrow();
    expect(() => parseTapeResponse(tapeBody([wireRow(1, { takerSide: "long" })]))).toThrow();
  });

  it("maps a house row to a maker fill on the opposite side of the taker", () => {
    const [buyRow] = parseTapeResponse(tapeBody([wireRow(7)]));
    const fill = mapTapeFill(buyRow as TapeFill, HOUSE, MARKET);
    expect(fill).toMatchObject({
      fillId: "NBTC-PERP:7",
      market: MARKET,
      makerSide: "sell",
      size: "120000",
      price: "75351.0",
      filledAt: new Date(1_800_000_000_007).toISOString(),
    });
    expect(makerFill.safeParse(fill).success).toBe(true);
    const [sellRow] = parseTapeResponse(tapeBody([wireRow(8, { takerSide: "sell" })]));
    expect(mapTapeFill(sellRow as TapeFill, HOUSE, MARKET)?.makerSide).toBe("buy");
  });

  it("emits nothing for other makers, other markets, or an unset house tag", () => {
    const rows = parseTapeResponse(tapeBody([wireRow(1, { makerTag: "5" }), wireRow(2, { market: "NETH-PERP" }), wireRow(3)]));
    expect(rows.map((row) => mapTapeFill(row, HOUSE, MARKET)?.fillId ?? null)).toEqual([null, null, "NBTC-PERP:3"]);
    expect(mapTapeFill(rows[2] as TapeFill, undefined, MARKET)).toBeNull();
  });
});

describe("position parsing", () => {
  it("maps signed decimals to signed 8 decimal units", () => {
    const parse = (size: string) =>
      parsePositionResponse({ market: MARKET, size, observedAt: "2026-11-06T08:00:00.000Z" }).position8;
    expect(parse("-0.0860")).toBe(-8_600_000n);
    expect(parse("0.0012")).toBe(120_000n);
    expect(parse("1")).toBe(100_000_000n);
    expect(parse("0")).toBe(0n);
  });

  it("rejects malformed positions", () => {
    expect(() => parsePositionResponse({ market: MARKET, size: "abc", observedAt: "x" })).toThrow();
    expect(() => parsePositionResponse({ position: "1" })).toThrow();
  });
});

describe("sequence cursor", () => {
  it("advances past rows that are not ours, in ascending order, and skips seen sequences", () => {
    const rows = parseTapeResponse(tapeBody([wireRow(12), wireRow(10, { makerTag: "5" }), wireRow(11)]));
    const first = mapTapeBatch(rows, MARKET, HOUSE, "");
    expect(first.fills.map((fill) => fill.fillId)).toEqual(["NBTC-PERP:11", "NBTC-PERP:12"]);
    expect(first.cursor).toBe("12");
    const again = mapTapeBatch(rows, MARKET, HOUSE, first.cursor);
    expect(again.fills).toEqual([]);
    expect(again.cursor).toBe("12");
    expect(mapTapeBatch([], MARKET, HOUSE, "12").cursor).toBe("12");
  });
});

describe("tape fill source", () => {
  it("requests the tape and the maker position with the documented query", async () => {
    const { api, fetchImpl } = fakeApi();
    const batch = await source(fetchImpl, join(SCRATCH, "q.json")).poll();
    expect(api.requested).toEqual([
      "/v1/tape?market=NBTC-PERP&limit=500",
      "/v1/maker/position?market=NBTC-PERP",
    ]);
    expect(batch.makerPosition8).toBe(-8_600_000n);
  });

  it("dedupes by sequence across polls and across a restart", async () => {
    const cursorFile = join(SCRATCH, "cursor.json");
    const { api, fetchImpl } = fakeApi();
    api.rows = [wireRow(1), wireRow(2, { makerTag: "5" })];
    const first = source(fetchImpl, cursorFile);
    const batch = await first.poll();
    expect(batch.fills.map((fill) => fill.fillId)).toEqual(["NBTC-PERP:1"]);
    expect(batch.cursor).toBe("2");
    await first.commit(batch.cursor);

    api.rows = [wireRow(1), wireRow(2, { makerTag: "5" }), wireRow(3, { takerSide: "sell" })];
    expect((await first.poll()).fills.map((fill) => fill.fillId)).toEqual(["NBTC-PERP:3"]);

    const restarted = source(fetchImpl, cursorFile);
    expect((await restarted.poll()).fills.map((fill) => fill.fillId)).toEqual(["NBTC-PERP:3"]);
    await restarted.commit("3");
    expect((await source(fetchImpl, cursorFile).poll()).fills).toEqual([]);
  });

  it("does not move the cursor on a failed poll", async () => {
    const cursorFile = join(SCRATCH, "cursor-fail.json");
    const { api, fetchImpl } = fakeApi();
    api.rows = [wireRow(4)];
    api.positionStatus = 503;
    const failing = source(fetchImpl, cursorFile);
    await expect(failing.poll()).rejects.toThrow(/503/);
    api.positionStatus = 200;
    expect((await failing.poll()).fills).toHaveLength(1);
  });

  it("emits no fill events but still reports the position without a house tag", async () => {
    const { api, fetchImpl } = fakeApi();
    api.rows = [wireRow(1)];
    const batch = await source(fetchImpl, join(SCRATCH, "notag.json"), null).poll();
    expect(batch.fills).toEqual([]);
    expect(batch.makerPosition8).toBe(-8_600_000n);
  });

  it("treats 503 and a network error as a plain failure and 404 as a config error", async () => {
    const { api, fetchImpl } = fakeApi();
    const src = source(fetchImpl, join(SCRATCH, "errs.json"));
    api.positionStatus = 503;
    const unavailable = await src.poll().catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable).not.toBeInstanceOf(FillSourceConfigError);
    api.positionStatus = 200;
    api.networkDown = true;
    const down = await src.poll().catch((error: unknown) => error);
    expect(down).toBeInstanceOf(TypeError);
    api.networkDown = false;
    api.positionStatus = 404;
    await expect(src.poll()).rejects.toBeInstanceOf(FillSourceConfigError);
    api.positionStatus = 200;
    api.tapeStatus = 400;
    await expect(src.poll()).rejects.toBeInstanceOf(FillSourceConfigError);
  });
});

describe("controller with the polled maker position", () => {
  function build(fetchImpl: typeof fetch, cursorFile: string) {
    const clock = makeHarness().clock;
    const venue = new MockVenue({ markPx8: 100_000n * 100_000_000n, accountValue6: 50_000_000_000n, clock: clock.now });
    const controller = new HedgeController({
      venue,
      fillSource: source(fetchImpl, cursorFile),
      journal: new Journal(new MemoryJournalStore()),
      bus: new EventBus(),
      clock: clock.now,
    });
    return { clock, venue, controller };
  }

  it("hedges the polled position, not the integrated fills", async () => {
    const { api, fetchImpl } = fakeApi();
    api.position = "0.05";
    api.rows = [wireRow(1)];
    const { venue, controller } = build(fetchImpl, join(SCRATCH, "ctl.json"));
    await controller.tick();
    expect(controller.makerPosition8).toBe(5_000_000n);
    expect(venue.truePosition8).toBe(-5_000_000n);
  });

  it("never hedges while the maker position is unknown, and recovers when it is readable", async () => {
    const { api, fetchImpl } = fakeApi();
    api.positionStatus = 503;
    const { clock, venue, controller } = build(fetchImpl, join(SCRATCH, "ctl-blind.json"));
    const blind = await controller.tick();
    expect(blind.decision).toBe("hold:maker-position-unknown");
    expect(venue.placeCalls).toHaveLength(0);

    clock.advance(20_000);
    const stale = await controller.tick();
    expect(stale.status).toBe("blind");
    expect(venue.placeCalls).toHaveLength(0);

    api.positionStatus = 200;
    api.position = "0.05";
    clock.advance(1_000);
    await controller.tick();
    expect(venue.truePosition8).toBe(-5_000_000n);
  });

  it("does not integrate fill events into the maker position", async () => {
    const { api, fetchImpl } = fakeApi();
    api.position = "0";
    api.rows = [wireRow(1), wireRow(2)];
    const { controller } = build(fetchImpl, join(SCRATCH, "ctl-fills.json"));
    const report = await controller.tick();
    expect(report.fillsProcessed).toBe(2);
    expect(controller.makerPosition8).toBe(0n);
  });
});
