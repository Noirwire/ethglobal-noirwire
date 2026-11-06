import { describe, expect, it } from "vitest";
import { bridgeTransfer, exposure, flowEvent, hedgeOrder, hedgeSideFor } from "./schemas.ts";

const now = "2026-11-06T08:00:00.000Z";

describe("hedge side", () => {
  it("hedges a maker buy with a sell and a maker sell with a buy", () => {
    expect(hedgeSideFor("buy")).toBe("sell");
    expect(hedgeSideFor("sell")).toBe("buy");
  });
});

describe("hedge orders", () => {
  const common = {
    sourceFillIds: ["f1"],
    side: "sell",
    size: "1000000",
    limitPrice: "100000.5",
    status: "sent",
    filledSize: "0",
    createdAt: now,
    updatedAt: now,
  } as const;

  it("accepts a Hyperliquid order with a 16-byte cloid", () => {
    const parsed = hedgeOrder.parse({
      ...common,
      venue: "hyperliquid",
      cloid: `0x${"ab".repeat(16)}`,
      coin: "BTC",
      assetIndex: 3,
      reduceOnly: false,
      tif: "Ioc",
    });
    expect(parsed.venue).toBe("hyperliquid");
  });

  it("rejects a Hyperliquid order with a 32-byte cloid", () => {
    expect(() =>
      hedgeOrder.parse({
        ...common,
        venue: "hyperliquid",
        cloid: `0x${"ab".repeat(32)}`,
        coin: "BTC",
        assetIndex: 3,
        reduceOnly: false,
        tif: "Ioc",
      }),
    ).toThrow();
  });

  it("accepts an Aqua order without a cloid", () => {
    const parsed = hedgeOrder.parse({
      ...common,
      venue: "aqua",
      strategyHash: `0x${"11".repeat(32)}`,
      maker: `0x${"22".repeat(20)}`,
    });
    expect(parsed.venue).toBe("aqua");
  });

  it("rejects a negative order size", () => {
    expect(() =>
      hedgeOrder.parse({
        ...common,
        size: "-1",
        venue: "aqua",
        strategyHash: `0x${"11".repeat(32)}`,
        maker: `0x${"22".repeat(20)}`,
      }),
    ).toThrow();
  });
});

describe("exposure", () => {
  it("allows signed positions", () => {
    const parsed = exposure.parse({
      market: "NBTC-PERP",
      makerPosition: "-17300000",
      hyperliquidPosition: "17300000",
      aquaInventory: "0",
      netResidual: "0",
      asOf: now,
    });
    expect(parsed.makerPosition).toBe("-17300000");
  });
});

describe("bridge transfers", () => {
  const transfer = {
    transferId: "t1",
    route: "solana-arc",
    sourceDomain: 5,
    destinationDomain: 26,
    grossAmount: "10000000",
    maxFee: "0",
    state: "burned",
    attester: "local-test-attester",
    updatedAt: now,
  } as const;

  it("accepts a burned Solana to Arc transfer", () => {
    expect(bridgeTransfer.parse(transfer).state).toBe("burned");
  });

  it("rejects a negative amount", () => {
    expect(() => bridgeTransfer.parse({ ...transfer, grossAmount: "-5" })).toThrow();
  });

  it("round trips through a flow event", () => {
    const event = flowEvent.parse({ kind: "transfer", at: now, transfer });
    expect(event.kind).toBe("transfer");
  });
});
