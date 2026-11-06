import { describe, expect, it, vi } from "vitest";
import { MemoryJournalStore } from "../src/journal.ts";
import { randomCloid } from "../src/controller.ts";
import {
  cloidFor,
  makeFill,
  makeHarness,
  MARK_PX8,
  netResidual8,
  restartController,
  TestClock,
} from "./harness.ts";

const BTC = 100_000_000n;

describe("unknown order outcomes", () => {
  it("does not hedge twice when the order filled, the call threw, the cancel failed and the position read is stale", async () => {
    const h = makeHarness();
    h.source.push(makeFill("f1", "buy", 1_000_000n));
    h.venue.throwAfterNextFill();
    h.venue.setCancelsFail(true);
    h.venue.serveStalePositionReads(4);

    await h.controller.tick();
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(1_000);
      await h.controller.tick();
    }

    expect(h.venue.placeCalls).toHaveLength(1);
    expect(h.venue.truePosition8).toBe(-1_000_000n);
    expect(h.controller.unresolvedCloids).toEqual([]);
    expect(netResidual8(h.controller, h.venue)).toBe(0n);
  });

  it("keeps a failed cancel unresolved and blocks new orders until the venue settles it", async () => {
    const h = makeHarness();
    const first = cloidFor(1);
    h.source.push(makeFill("f1", "buy", 1_000_000n));
    h.venue.throwAfterNextFill();
    h.venue.setCancelsFail(true);
    h.venue.overrideStatus(first, { state: "open", filled8: 0n });

    await h.controller.tick();
    expect(h.controller.unresolvedCloids).toEqual([first]);

    h.source.push(makeFill("f2", "buy", 5_000_000n));
    h.clock.advance(1_000);
    const blocked = await h.controller.tick();
    expect(blocked.decision).toBe("hold:unresolved-order");
    expect(h.venue.placeCalls).toHaveLength(1);

    h.venue.setCancelsFail(false);
    h.venue.overrideStatus(first, { state: "filled", filled8: 1_000_000n, avgPx8: MARK_PX8 });
    h.clock.advance(1_000);
    await h.controller.tick();
    expect(h.controller.unresolvedCloids).toEqual([]);
    h.clock.advance(1_000);
    await h.controller.tick();
    expect(h.venue.placeCalls.length).toBeGreaterThan(1);
  });

  it("waits for the venue to know an order before declaring it never placed", async () => {
    const h = makeHarness({ config: { unknownOrderGraceMs: 10_000 } });
    const first = cloidFor(1);
    h.source.push(makeFill("f1", "buy", 1_000_000n));
    h.venue.throwBeforeNextFill();
    h.venue.hideStatusFor(first);

    await h.controller.tick();
    expect(h.controller.unresolvedCloids).toEqual([first]);

    h.clock.advance(5_000);
    const early = await h.controller.tick();
    expect(early.decision).toBe("hold:unresolved-order");
    expect(h.venue.placeCalls).toHaveLength(1);

    h.clock.advance(6_000);
    await h.controller.tick();
    expect(h.controller.unresolvedCloids).toEqual([]);
    h.clock.advance(1_000);
    await h.controller.tick();
    expect(h.venue.placeCalls).toHaveLength(2);
    expect(netResidual8(h.controller, h.venue)).toBe(0n);
  });
});

describe("margin room", () => {
  it("sizes the hedge against margin room at the venue mark, not the reference price", async () => {
    const reference = { get: async () => ({ px8: 50_000n * BTC, at: Date.now() }) };
    const clock = new TestClock(Date.now());
    const h = makeHarness({
      clock,
      reference,
      venue: { accountValue6: 1_000_000_000n },
      config: { maxOrder8: 50_000_000n },
    });
    h.source.push(makeFill("f1", "buy", 8_000_000n));

    await h.controller.tick();

    expect(h.venue.placeCalls[0]?.size8).toBe(5_000_000n);
  });

  it("shrinks the maximum order size when the margin ratio is urgent and publishes the intent", async () => {
    const h = makeHarness({
      venue: { accountValue6: 12_000_000_000n, initialPosition8: -50_000_000n, spec: { maxLeverage: 5 } },
      config: { maxOrder8: 8_000_000n, initialMakerPosition8: 90_000_000n },
    });
    await h.controller.tick();

    expect(h.venue.placeCalls[0]?.size8).toBe(4_000_000n);
    const intents = h.bus.recent().filter((event) => event.kind === "intent");
    expect(intents[0]?.kind === "intent" && intents[0].intent.reason).toBe("margin-urgent");
  });
});

describe("read ordering", () => {
  it("reflects a maker fill that lands between the venue read and the maker position read", async () => {
    const h = makeHarness();
    h.venue.onPositionRead(() => {
      h.source.push(makeFill("late", "buy", 3_000_000n));
      h.venue.onPositionRead(null);
    });

    const report = await h.controller.tick();

    expect(report.decision.startsWith("order:")).toBe(true);
    expect(h.venue.placeCalls[0]).toMatchObject({ side: "sell", size8: 3_000_000n });
    expect(netResidual8(h.controller, h.venue)).toBe(0n);
  });
});

describe("convergence and recovery", () => {
  it("converges over several ticks when orders only partially fill", async () => {
    const h = makeHarness();
    h.source.push(makeFill("f1", "buy", 10_000_000n));
    for (const ratio of [0.5, 0.5, 0.5]) h.venue.fillRatioNext(ratio);

    for (let i = 0; i < 12; i += 1) {
      await h.controller.tick();
      h.clock.advance(3_000);
    }

    expect(h.venue.placeCalls.length).toBeGreaterThanOrEqual(4);
    expect(netResidual8(h.controller, h.venue)).toBe(0n);
  });

  it("backs off after a margin rejection and retries once the backoff passes", async () => {
    const h = makeHarness({ config: { backoffBaseMs: 2_000 } });
    h.source.push(makeFill("f1", "buy", 5_000_000n));
    h.venue.rejectNext("perpMarginRejected");

    const first = await h.controller.tick();
    expect(first.decision.startsWith("order:")).toBe(true);
    expect(h.venue.truePosition8).toBe(0n);

    const held = await h.controller.tick();
    expect(held.decision).toBe("hold:backoff");
    expect(h.venue.placeCalls).toHaveLength(1);

    h.clock.advance(2_500);
    await h.controller.tick();
    expect(h.venue.placeCalls).toHaveLength(2);
    expect(h.venue.placeCalls[1]!.size8).toBeLessThanOrEqual(h.venue.placeCalls[0]!.size8);
    expect(h.venue.truePosition8).toBe(-5_000_000n);
  });

  it("reconciles a journaled order against the venue before trading after a crash", async () => {
    const store = new MemoryJournalStore();
    const clock = new TestClock();
    const before = makeHarness({ store, clock });
    before.source.push(makeFill("f1", "buy", 2_000_000n));
    before.venue.throwBeforeNextFill();
    await before.controller.tick();
    const pending = cloidFor(1);
    expect(before.controller.unresolvedCloids).toEqual([pending]);

    const venue = before.venue;
    await venue.placeIoc({ cloid: pending, side: "sell", size8: 2_000_000n, limitPx8: 99_700n * BTC, reduceOnly: false });
    const statusSpy = vi.spyOn(venue, "orderStatusByCloid");
    const placeSpy = vi.spyOn(venue, "placeIoc");

    const restarted = restartController(before);
    await restarted.start();

    expect(statusSpy).toHaveBeenCalledWith(pending);
    expect(restarted.unresolvedCloids).toEqual([]);
    expect(restarted.makerPosition8).toBe(2_000_000n);

    clock.advance(1_000);
    await restarted.tick();
    expect(placeSpy).not.toHaveBeenCalled();
    expect(netResidual8(restarted, venue)).toBe(0n);
  });

  it("holds new orders after a restart until an order the venue never saw ages out of the grace window", async () => {
    const store = new MemoryJournalStore();
    const clock = new TestClock();
    const crashed = makeHarness({ store, clock });
    crashed.source.push(makeFill("f1", "buy", 2_000_000n));
    crashed.venue.throwBeforeNextFill();
    crashed.venue.hideStatusFor(cloidFor(1));
    await crashed.controller.tick();

    const restarted = restartController(crashed, { unknownOrderGraceMs: 10_000 });
    await restarted.start();
    expect((await restarted.tick()).decision).toBe("hold:unresolved-order");

    clock.advance(11_000);
    await restarted.tick();
    clock.advance(1_000);
    await restarted.tick();
    expect(crashed.venue.truePosition8).toBe(-2_000_000n);
  });

  it("does not double count a maker fill delivered twice", async () => {
    const h = makeHarness();
    const fill = makeFill("dup", "buy", 1_000_000n);
    h.source.push(fill, fill);
    await h.controller.tick();
    expect(h.controller.makerPosition8).toBe(1_000_000n);
  });

  it("ignores maker fills from other markets", async () => {
    const h = makeHarness();
    h.source.push(makeFill("x1", "buy", 1_000_000n, "NETH-PERP"));
    await h.controller.tick();
    expect(h.controller.makerPosition8).toBe(0n);
    expect(h.venue.placeCalls).toHaveLength(0);
  });

  it("observes without trading when hedging is disabled", async () => {
    const h = makeHarness({ config: { enabled: false } });
    h.source.push(makeFill("f1", "buy", 5_000_000n));
    const report = await h.controller.tick();
    expect(report.decision).toBe("hold:disabled");
    expect(h.venue.placeCalls).toHaveLength(0);
    expect(h.controller.snapshot().netResidual).toBe("0.05");
  });
});

describe("client order ids", () => {
  it("generates unique 16 byte cloids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) {
      const cloid = randomCloid();
      expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
      seen.add(cloid);
    }
    expect(seen.size).toBe(5_000);
  });

  it("never reuses a cloid across the orders it places", async () => {
    const h = makeHarness({ newCloid: randomCloid });
    for (let i = 0; i < 10; i += 1) {
      h.source.push(makeFill(`f${i}`, i % 2 === 0 ? "buy" : "sell", 3_000_000n + BigInt(i) * 1_000n));
      await h.controller.tick();
      h.clock.advance(1_000);
    }
    const cloids = h.venue.placeCalls.map((call) => call.cloid);
    expect(new Set(cloids).size).toBe(cloids.length);
    expect(cloids.length).toBeGreaterThanOrEqual(8);
  });

  it("writes the intent to the journal before the order reaches the venue", async () => {
    const h = makeHarness();
    h.source.push(makeFill("f1", "buy", 1_000_000n));
    const original = h.venue.placeIoc.bind(h.venue);
    let journaledAtSend = false;
    h.venue.placeIoc = async (request) => {
      journaledAtSend = h.store.readLines().some((line) => line.includes(`"intent"`) && line.includes(request.cloid));
      return original(request);
    };
    await h.controller.tick();
    expect(journaledAtSend).toBe(true);
  });
});
