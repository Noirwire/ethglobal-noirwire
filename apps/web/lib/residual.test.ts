import { describe, expect, it } from "vitest";
import { axisRange8, deviationPercent, hedgerStatusLabel, netResidual8, residualState } from "./residual";

describe("residual", () => {
  const band = 1_000_000n;

  it("sums maker, perp and spot", () => {
    expect(netResidual8(5_000_000n, -4_000_000n, -1_000_000n)).toBe(0n);
    expect(netResidual8(5_000_000n, -4_000_000n, 0n)).toBe(1_000_000n);
  });

  it("is inside the band up to and including the threshold", () => {
    expect(residualState(0n, band)).toBe("inside");
    expect(residualState(band, band)).toBe("inside");
    expect(residualState(-band, band)).toBe("inside");
    expect(residualState(band + 1n, band)).toBe("outside");
    expect(residualState(-band - 1n, band)).toBe("outside");
  });

  it("maps lagging to hedging", () => {
    expect(hedgerStatusLabel("lagging")).toBe("hedging");
    expect(hedgerStatusLabel("blind")).toBe("blind");
  });

  it("scales bars against a shared axis and clamps", () => {
    const range = axisRange8([3_000_000n, -2_000_000n], band);
    expect(range).toBe(3_000_000n);
    expect(deviationPercent(3_000_000n, range)).toBe(100);
    expect(deviationPercent(-1_500_000n, range)).toBe(-50);
    expect(deviationPercent(9_000_000n, range)).toBe(100);
    expect(axisRange8([], 0n)).toBe(1n);
  });
});
