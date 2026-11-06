import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makerFill } from "@noirwire/shared";
import { parseReplayFile, ReplayFillSource, scriptedDemoFills } from "../src/sources/replay.ts";

const SCRATCH = join(import.meta.dirname, "..", ".test-tmp", "sources");

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

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
