export type HedgerStatus = "hedged" | "hedging" | "blind" | "halted";

export type ResidualState = "inside" | "outside";

export function netResidual8(maker: bigint, hyperliquid: bigint, aqua: bigint): bigint {
  return maker + hyperliquid + aqua;
}

export function residualState(residual8: bigint, band8: bigint): ResidualState {
  const magnitude = residual8 < 0n ? -residual8 : residual8;
  return magnitude <= band8 ? "inside" : "outside";
}

export function hedgerStatusLabel(status: "hedged" | "lagging" | "blind" | "halted"): HedgerStatus {
  return status === "lagging" ? "hedging" : status;
}

export function axisRange8(values: bigint[], band8: bigint): bigint {
  let max = band8 * 2n;
  for (const value of values) {
    const magnitude = value < 0n ? -value : value;
    if (magnitude > max) max = magnitude;
  }
  return max === 0n ? 1n : max;
}

export function deviationPercent(value8: bigint, range8: bigint): number {
  const scaled = Number((value8 * 10_000n) / range8) / 100;
  return Math.max(-100, Math.min(100, scaled));
}
