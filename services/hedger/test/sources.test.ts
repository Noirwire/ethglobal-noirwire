import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makerFill } from "@noirwire/shared";
import { mapTapeResponse, mapTapeRow, TapeFillSource } from "../src/sources/tape.ts";
import { parseReplayFile, ReplayFillSource, scriptedDemoFills } from "../src/sources/replay.ts";

const SCRATCH = join(import.meta.dirname, "..", ".test-tmp", "sources");

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const row = { id: "t1", market: "NBTC-PERP", side: "buy", size: "0.01", price: "100000", ts: 1_800_000_000_000, maker: true };

describe("tape mapping", () => {
  it("maps a house maker row to a maker fill on the opposite side of the taker", () => {
    const fill = mapTapeRow(row, "NBTC-PERP");
    expect(fill).toMatchObject({ fillId: "t1", makerSide: "sell", size: "1000000", price: "100000" });
    expect(makerFill.safeParse(fill).success).toBe(true);
    expect(fill?.filledAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("keeps only fills where the house maker is a party and the market matches", () => {
    expect(mapTapeRow({ ...row, maker: false }, "NBTC-PERP")).toBeNull();
    expect(mapTapeRow({ ...row, market: "NETH-PERP" }, "NBTC-PERP")).toBeNull();
  });

  it("accepts numeric ids, numeric sizes and iso timestamps", () => {
    const fill = mapTapeRow({ ...row, id: 42, size: 0.25, price: 99999.5, ts: "2026-11-06T08:00:00.000Z" }, "NBTC-PERP");
    expect(fill).toMatchObject({ fillId: "42", size: "25000000", price: "99999.5" });
  });

  it("rejects malformed rows loudly", () => {
    expect(() => mapTapeRow({ id: "x" }, "NBTC-PERP")).toThrow();
  });

  it("advances the cursor past rows that are not ours and honors an explicit cursor", () => {
    const rows = [{ ...row, id: "a", maker: false }, { ...row, id: "b" }];
    const bare = mapTapeResponse(rows, "NBTC-PERP", "");
    expect(bare.fills.map((fill) => fill.fillId)).toEqual(["b"]);
    expect(bare.cursor).toBe("b");
    expect(mapTapeResponse({ rows, cursor: "next-7" }, "NBTC-PERP", "").cursor).toBe("next-7");
    expect(mapTapeResponse([], "NBTC-PERP", "keep").cursor).toBe("keep");
  });
});

describe("tape fill source", () => {
  it("polls with the market and cursor, and persists the cursor across restarts", async () => {
    const cursorFile = join(SCRATCH, "cursor.json");
    const requested: string[] = [];
    const fetchImpl = (async (input: URL | string) => {
      requested.push(String(input));
      return new Response(JSON.stringify([row]), { status: 200 });
    }) as typeof fetch;

    const first = new TapeFillSource({ bookApiUrl: "http://book.test", market: "NBTC-PERP", cursorFile, fetchImpl });
    const batch = await first.poll();
    expect(requested[0]).toBe("http://book.test/v1/tape?market=NBTC-PERP&since=");
    expect(batch.fills).toHaveLength(1);
    await first.commit(batch.cursor);

    const second = new TapeFillSource({ bookApiUrl: "http://book.test", market: "NBTC-PERP", cursorFile, fetchImpl });
    await second.poll();
    expect(requested[1]).toBe("http://book.test/v1/tape?market=NBTC-PERP&since=t1");
  });

  it("does not move the cursor when the request fails", async () => {
    const cursorFile = join(SCRATCH, "cursor-fail.json");
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const source = new TapeFillSource({ bookApiUrl: "http://book.test", market: "NBTC-PERP", cursorFile, fetchImpl });
    await expect(source.poll()).rejects.toThrow(/500/);
  });
});

describe("replay fill source", () => {
  it("reads maker fills from an ndjson file", () => {
    const file = join(SCRATCH, "fills.ndjson");
    const fills = scriptedDemoFills("NBTC-PERP", 1_800_000_000_000).slice(0, 2);
    writeFileSync(file, `${fills.map((fill) => JSON.stringify(fill)).join("\n")}\n`);
    expect(parseReplayFile(file)).toEqual(fills);
  });

  it("hands out fills in order and only advances on commit", async () => {
    const source = new ReplayFillSource(scriptedDemoFills("NBTC-PERP", 0), 2);
    const first = await source.poll();
    expect(first.fills.map((fill) => fill.fillId)).toEqual(["demo-1", "demo-2"]);
    expect((await source.poll()).fills[0]?.fillId).toBe("demo-1");
    await source.commit(first.cursor);
    expect((await source.poll()).fills[0]?.fillId).toBe("demo-3");
  });

  it("generates a valid scripted sequence", () => {
    for (const fill of scriptedDemoFills("NBTC-PERP", 0)) expect(makerFill.safeParse(fill).success).toBe(true);
  });
});
