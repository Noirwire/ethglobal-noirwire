import { describe, expect, it } from "vitest";
import { makeFill, makeHarness } from "./harness.ts";

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("residual exposure", () => {
  it("ends within the deadband over random fill sequences, partial fills and rejections", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = mulberry32(seed);
      const h = makeHarness({ venue: { accountValue6: 5_000_000_000_000n } });
      const deadband = h.controller.config.deadband8;
      const fillCount = 5 + Math.floor(random() * 30);

      for (let i = 0; i < fillCount; i += 1) {
        const size = BigInt(1 + Math.floor(random() * 40_000_000));
        h.source.push(makeFill(`s${seed}-${i}`, random() < 0.5 ? "buy" : "sell", size));
        if (random() < 0.25) h.venue.fillRatioNext(0.2 + random() * 0.6);
        if (random() < 0.1) h.venue.rejectNext("perpMarginRejected");
        if (random() < 0.05) h.venue.throwAfterNextFill();
        await h.controller.tick();
        h.clock.advance(2_500);
      }
      for (let i = 0; i < 80; i += 1) {
        await h.controller.tick();
        h.clock.advance(5_000);
      }

      const residual = h.controller.makerPosition8 + h.venue.truePosition8;
      const absResidual = residual < 0n ? -residual : residual;
      expect(absResidual, `seed ${seed}`).toBeLessThanOrEqual(deadband);
      expect(h.controller.unresolvedCloids, `seed ${seed}`).toEqual([]);
    }
  });
});
