import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, existsSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { makerFill } from "@noirwire/shared";
import { z } from "zod";

const bigintString = z.string().regex(/^-?\d+$/);
const cloid = z.string().regex(/^0x[0-9a-fA-F]{32}$/);

const intentEntry = z.object({
  type: z.literal("intent"),
  t: z.number(),
  cloid,
  side: z.enum(["buy", "sell"]),
  size8: bigintString,
  limitPx8: bigintString,
  reduceOnly: z.boolean(),
  positionBefore8: bigintString,
  sourceFillIds: z.array(z.string()),
});

const outcomeEntry = z.object({
  type: z.literal("outcome"),
  t: z.number(),
  cloid,
  outcome: z.enum(["filled", "partial", "unfilled", "rejected"]),
  filled8: bigintString,
  avgPx8: bigintString.optional(),
  reason: z.string().optional(),
});

const unresolvedEntry = z.object({
  type: z.literal("unresolved"),
  t: z.number(),
  cloid,
  reason: z.string(),
});

const resolvedEntry = z.object({
  type: z.literal("resolved"),
  t: z.number(),
  cloid,
  final: z.enum(["filled", "partial", "cancelled", "rejected", "not-placed"]),
  filled8: bigintString,
  avgPx8: bigintString.optional(),
});

const fillEntry = z.object({ type: z.literal("fill"), t: z.number(), fill: makerFill });

export const journalEntry = z.discriminatedUnion("type", [
  intentEntry,
  outcomeEntry,
  unresolvedEntry,
  resolvedEntry,
  fillEntry,
]);
export type JournalEntry = z.infer<typeof journalEntry>;

export interface JournalStore {
  append(line: string): void;
  readLines(): string[];
}

export class MemoryJournalStore implements JournalStore {
  private readonly lines: string[] = [];
  append(line: string): void {
    this.lines.push(line);
  }
  readLines(): string[] {
    return [...this.lines];
  }
}

export class FileJournalStore implements JournalStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(line: string): void {
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readLines(): string[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter((line) => line.length > 0);
  }
}

export class Journal {
  constructor(private readonly store: JournalStore) {}

  append(entry: JournalEntry): void {
    this.store.append(JSON.stringify(journalEntry.parse(entry)));
  }

  entries(): JournalEntry[] {
    const parsed: JournalEntry[] = [];
    for (const line of this.store.readLines()) {
      try {
        parsed.push(journalEntry.parse(JSON.parse(line)));
      } catch {
        continue;
      }
    }
    return parsed;
  }
}

export interface JournalOrder {
  cloid: string;
  side: "buy" | "sell";
  size8: bigint;
  limitPx8: bigint;
  reduceOnly: boolean;
  positionBefore8: bigint;
  sourceFillIds: string[];
  intentAt: number;
  settled: boolean;
  filled8: bigint;
  avgPx8?: bigint;
  final?: string;
  reason?: string;
}

export interface JournalState {
  fills: Map<string, z.infer<typeof makerFill>>;
  orders: Map<string, JournalOrder>;
}

export function newJournalState(): JournalState {
  return { fills: new Map(), orders: new Map() };
}

export function replayJournal(entries: JournalEntry[]): JournalState {
  const state = newJournalState();
  for (const entry of entries) applyEntry(state, entry);
  return state;
}

export function applyEntry(state: JournalState, entry: JournalEntry): void {
  {
    if (entry.type === "fill") {
      state.fills.set(entry.fill.fillId, entry.fill);
    } else if (entry.type === "intent") {
      state.orders.set(entry.cloid, {
        cloid: entry.cloid,
        side: entry.side,
        size8: BigInt(entry.size8),
        limitPx8: BigInt(entry.limitPx8),
        reduceOnly: entry.reduceOnly,
        positionBefore8: BigInt(entry.positionBefore8),
        sourceFillIds: entry.sourceFillIds,
        intentAt: entry.t,
        settled: false,
        filled8: 0n,
      });
    } else if (entry.type === "outcome") {
      const order = state.orders.get(entry.cloid);
      if (!order) return;
      order.filled8 = BigInt(entry.filled8);
      if (entry.avgPx8) order.avgPx8 = BigInt(entry.avgPx8);
      order.settled = true;
      order.final = entry.outcome;
      order.reason = entry.reason;
    } else if (entry.type === "resolved") {
      const order = state.orders.get(entry.cloid);
      if (!order) return;
      order.filled8 = BigInt(entry.filled8);
      if (entry.avgPx8) order.avgPx8 = BigInt(entry.avgPx8);
      order.settled = true;
      order.final = entry.final;
    } else if (entry.type === "unresolved") {
      const order = state.orders.get(entry.cloid);
      if (order) {
        order.settled = false;
        order.reason = entry.reason;
      }
    }
  }
}

export function unresolvedOrders(state: JournalState): JournalOrder[] {
  return [...state.orders.values()].filter((order) => !order.settled);
}
