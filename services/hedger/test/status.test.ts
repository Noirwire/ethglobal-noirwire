import { describe, expect, it } from "vitest";
import { makerQuotePolicy } from "../src/policy.ts";
import { makeFill, makeHarness } from "./harness.ts";

describe("hedge status", () => {
  it("stays hedged while exposure is under the soft limit and every order is held for minimum size", async () => {
    const h = makeHarness();
    h.source.push(makeFill("tiny", "buy", 5_000n));

    for (let i = 0; i < 8; i += 1) {
      const report = await h.controller.tick();
      expect(report.decision).toBe("hold:within-deadband");
      expect(report.status).toBe("hedged");
      h.clock.advance(20_000);
    }
    expect(h.venue.placeCalls).toHaveLength(0);
  });

  it("goes lagging when exposure sits above the soft limit and is not being hedged", async () => {
    const h = makeHarness();
    h.source.push(makeFill("big", "buy", 4_000_000n));
    h.venue.rejectNext("perpMarginRejected");
    h.venue.rejectNext("perpMarginRejected");

    const first = await h.controller.tick();
    expect(first.status).not.toBe("hedged");
    h.clock.advance(40_000);
    const second = await h.controller.tick();
    expect(second.status).toBe("lagging");
  });

  it("treats exposure as at the hard limit when the reference price has expired", async () => {
    const h = makeHarness({
      reference: { get: async () => ({ px8: 100_000n * 100_000_000n, at: 1 }) },
    });
    const report = await h.controller.tick();

    expect(report.status).toBe("halted");
    const snapshot = h.controller.snapshot();
    expect(snapshot.referenceExpired).toBe(true);
    expect(snapshot.unhedgedNotionalUsd6).toBe(h.controller.config.hardLimitUsd6.toString());
  });

  it("is blind before the first venue read and again during a venue outage", async () => {
    const h = makeHarness();
    expect(h.controller.snapshot().status).toBe("blind");

    expect((await h.controller.tick()).status).toBe("hedged");
    h.venue.setOutage(true);
    h.clock.advance(20_000);
    const report = await h.controller.tick();
    expect(report.status).toBe("blind");
    expect(report.decision).toBe("hold:blind");

    h.venue.setOutage(false);
    h.clock.advance(1_000);
    expect((await h.controller.tick()).status).toBe("hedged");
  });

  it("halts on request and recovers when resumed", async () => {
    const h = makeHarness();
    h.controller.halt("operator");
    expect((await h.controller.tick()).status).toBe("halted");
    h.controller.resume();
    expect((await h.controller.tick()).status).toBe("hedged");
  });
});

describe("maker quote policy", () => {
  it("quotes normally but thin when the maker is flat and the hedger is blind", () => {
    const policy = makerQuotePolicy("blind", 0n);
    expect(policy.mode).toBe("thin");
    expect(policy.sizeFactorBps).toBeGreaterThan(0);
    expect(policy.sizeFactorBps).toBeLessThan(10_000);
  });

  it("only allows position reducing quotes when the maker holds a position and the hedger is blind", () => {
    expect(makerQuotePolicy("blind", 5_000_000n).mode).toBe("reduce-only");
    expect(makerQuotePolicy("blind", -5_000_000n).mode).toBe("reduce-only");
  });

  it("quotes at full size only when hedged", () => {
    expect(makerQuotePolicy("hedged", 1n)).toMatchObject({ mode: "normal", sizeFactorBps: 10_000 });
    expect(makerQuotePolicy("lagging", 1n).mode).toBe("thin");
  });

  it("stops quoting when halted and flat, and reduces only when halted with a position", () => {
    expect(makerQuotePolicy("halted", 0n).mode).toBe("stop");
    expect(makerQuotePolicy("halted", 1n).mode).toBe("reduce-only");
  });
});
