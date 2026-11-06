import { describe, expect, it } from "vitest";
import { fromBaseUnits, toBaseUnits } from "./units.ts";

describe("base unit conversion", () => {
  it("round trips BTC sizes", () => {
    expect(toBaseUnits("0.173", 8)).toBe(17_300_000n);
    expect(fromBaseUnits(17_300_000n, 8)).toBe("0.173");
  });

  it("handles negatives and whole numbers", () => {
    expect(toBaseUnits("-2", 6)).toBe(-2_000_000n);
    expect(fromBaseUnits(-2_000_000n, 6)).toBe("-2");
    expect(fromBaseUnits(5n, 6)).toBe("0.000005");
  });

  it("rejects excess precision", () => {
    expect(() => toBaseUnits("1.1234567", 6)).toThrow();
  });
});
