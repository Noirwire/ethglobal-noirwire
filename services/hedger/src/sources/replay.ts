import { readFileSync } from "node:fs";
import { makerFill, toBaseUnits, type MakerFill } from "@noirwire/shared";
import type { FillBatch, FillSource } from "../types.ts";

export function parseReplayFile(path: string): MakerFill[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => makerFill.parse(JSON.parse(line)));
}

export class ReplayFillSource implements FillSource {
  private index = 0;

  constructor(
    private fills: MakerFill[],
    private readonly perPoll = 1,
  ) {}

  static fromFile(path: string, perPoll = 1): ReplayFillSource {
    return new ReplayFillSource(parseReplayFile(path), perPoll);
  }

  push(...more: MakerFill[]): void {
    this.fills = [...this.fills, ...more];
  }

  get remaining(): number {
    return this.fills.length - this.index;
  }

  async poll(): Promise<FillBatch> {
    const batch = this.fills.slice(this.index, this.index + this.perPoll);
    return { fills: batch, cursor: String(this.index + batch.length) };
  }

  async commit(cursor: string): Promise<void> {
    this.index = Number(cursor);
  }
}

const DEMO_STEPS: Array<[side: "buy" | "sell", size: string, price: string]> = [
  ["buy", "0.05", "100000"],
  ["buy", "0.03", "100040"],
  ["sell", "0.02", "100010"],
  ["sell", "0.11", "99980"],
  ["buy", "0.004", "100020"],
  ["buy", "0.2", "100100"],
  ["sell", "0.15", "100060"],
  ["sell", "0.09", "100000"],
];

export function scriptedDemoFills(market: string, startMs: number, stepMs = 1000): MakerFill[] {
  return DEMO_STEPS.map(([makerSide, size, price], index) => ({
    fillId: `demo-${index + 1}`,
    market,
    makerSide,
    size: toBaseUnits(size, 8).toString(),
    price,
    filledAt: new Date(startMs + index * stepMs).toISOString(),
  }));
}
