import { flowEvent } from "@noirwire/shared";
import { describe, expect, it } from "vitest";
import { aquaHedgeEvent, emitEvent, toNdjson } from "../src/events.ts";
import { loadConfig } from "../src/config.ts";

const input = {
  strategyHash: `0x${"ab".repeat(32)}`,
  maker: "0x1206FDb9838E5f74Bc1e2636462483fae6658bd5",
  txHash: `0x${"cd".repeat(32)}`,
  sourceFillIds: ["fill-1"],
  makerSellsBtc: true,
  size8: 50_000_000n,
  limitPriceE8: 7_184_899_037_958n,
  status: "partial" as const,
  filledSize8: 990_099n,
  avgPriceE8: 7_638_682_202_486n,
  createdAt: new Date("2026-11-06T07:00:00.000Z"),
  updatedAt: new Date("2026-11-06T07:00:05.000Z"),
};

describe("FlowEvent output", () => {
  it("produces a hedge event on the aqua venue with unsigned base unit sizes", () => {
    const event = aquaHedgeEvent(input);
    expect(event.kind).toBe("hedge");
    if (event.kind !== "hedge") throw new Error("unreachable");
    expect(event.order.venue).toBe("aqua");
    expect(event.order).toMatchObject({
      side: "sell",
      size: "50000000",
      filledSize: "990099",
      limitPrice: "71848.99037958",
      avgPrice: "76386.82202486",
    });
    expect("cloid" in event.order).toBe(false);
  });

  it("maps a maker that buys BTC to a buy side hedge", () => {
    const event = aquaHedgeEvent({ ...input, makerSellsBtc: false });
    expect(event.kind === "hedge" && event.order.side).toBe("buy");
  });

  it("serialises to one NDJSON line that parses back through the shared schema", () => {
    const line = toNdjson(aquaHedgeEvent(input));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(flowEvent.parse(JSON.parse(line)).kind).toBe("hedge");
  });

  it("writes through the supplied sink", () => {
    const lines: string[] = [];
    emitEvent(aquaHedgeEvent(input), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
  });

  it("rejects a malformed strategy hash and an empty fill id list", () => {
    expect(() => aquaHedgeEvent({ ...input, strategyHash: "0x1234" })).toThrow();
    expect(() => aquaHedgeEvent({ ...input, sourceFillIds: [] })).toThrow();
  });

  it("carries the revert reason on a rejected hedge", () => {
    const event = aquaHedgeEvent({ ...input, status: "rejected", filledSize8: 0n, avgPriceE8: undefined, error: "HedgeGuard__WrongDirection" });
    expect(event.kind === "hedge" && event.order.error).toBe("HedgeGuard__WrongDirection");
  });
});

describe("config", () => {
  it("defaults to the local aqua fork and the labelled test aggregator", () => {
    const config = loadConfig({});
    expect(config.AQUA_FORK_RPC).toBe("http://127.0.0.1:8546");
    expect(config.AQUA_ORACLE).toBe("test-aggregator");
  });

  it("rejects an unknown oracle mode and a malformed gate token", () => {
    expect(() => loadConfig({ AQUA_ORACLE: "pyth" })).toThrow();
    expect(() => loadConfig({ AQUA_TAKER_GATE_TOKEN: "0x12" })).toThrow();
  });
});
