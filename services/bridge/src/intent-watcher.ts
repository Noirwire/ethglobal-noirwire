import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { topUpIntent, type TopUpIntent, type TransferRoute } from "@noirwire/shared";
import { parseAbiItem, type Hex, type PublicClient } from "viem";
import { IntentRejected, RouteUnavailable, type TreasuryExecutor } from "./executor.ts";

export const topUpIntentRecordedEvent = parseAbiItem(
  "event TopUpIntentRecorded(bytes32 indexed intentId, uint64 closeId, uint8 route, uint256 amount, uint16 marginRatioBps, uint8 reason)",
);

const ROUTES: readonly TransferRoute[] = ["arc-hypercore", "hypercore-arc", "arc-solana", "solana-arc"];
const REASONS: readonly TopUpIntent["reason"][] = ["margin-low", "margin-urgent", "surplus-return", "solana-rebalance"];

export type IntentLog = {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  args: Partial<{
    intentId: Hex;
    closeId: bigint;
    route: number;
    amount: bigint;
    marginRatioBps: number;
    reason: number;
  }>;
};

export interface IntentLogReader {
  head(): Promise<bigint>;
  logs(from: bigint, to: bigint): Promise<IntentLog[]>;
}

export class ViemIntentLogReader implements IntentLogReader {
  constructor(
    private readonly client: PublicClient,
    private readonly receiver: Hex,
  ) {}

  head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async logs(from: bigint, to: bigint): Promise<IntentLog[]> {
    const logs = await this.client.getLogs({
      address: this.receiver,
      event: topUpIntentRecordedEvent,
      fromBlock: from,
      toBlock: to,
    });
    return logs.map((log) => ({
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
      transactionHash: log.transactionHash ?? "",
      args: log.args,
    }));
  }
}

export class DurableCursor {
  constructor(private readonly path: string) {}

  load(): bigint | undefined {
    if (!existsSync(this.path)) return undefined;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { nextBlock?: unknown };
    if (typeof parsed.nextBlock !== "string" || !/^\d+$/.test(parsed.nextBlock)) {
      throw new Error(`intent cursor ${this.path} is unreadable, refusing to guess where to resume`);
    }
    return BigInt(parsed.nextBlock);
  }

  save(nextBlock: bigint): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, JSON.stringify({ nextBlock: nextBlock.toString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    const dir = openSync(dirname(this.path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}

export type WatcherOptions = {
  confirmations: bigint;
  maxRange?: bigint;
  startBlock?: bigint;
};

const DEFAULT_CONFIRMATIONS = "2";
const DEFAULT_POLL_MS = "10000";
const DEFAULT_CURSOR_FILE = "./data/intent-cursor.json";

export function watcherSettings(env: (name: string) => string | undefined): {
  options: WatcherOptions;
  cursorFile: string;
  pollMs: number;
} {
  const startBlock = env("INTENT_START_BLOCK");
  return {
    options: {
      confirmations: BigInt(env("INTENT_CONFIRMATIONS") ?? DEFAULT_CONFIRMATIONS),
      startBlock: startBlock === undefined ? undefined : BigInt(startBlock),
    },
    cursorFile: env("INTENT_CURSOR_FILE") ?? DEFAULT_CURSOR_FILE,
    pollMs: Number(env("INTENT_POLL_MS") ?? DEFAULT_POLL_MS),
  };
}

export type PollResult = { submitted: number; refused: number; malformed: number };

const DEFAULT_MAX_RANGE = 2000n;

export function decodeIntent(log: IntentLog): TopUpIntent | undefined {
  const a = log.args;
  if (
    a.intentId === undefined ||
    a.closeId === undefined ||
    a.route === undefined ||
    a.amount === undefined ||
    a.marginRatioBps === undefined ||
    a.reason === undefined
  ) {
    return undefined;
  }
  const route = ROUTES[a.route];
  const reason = REASONS[a.reason];
  if (!route || !reason || a.closeId > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const parsed = topUpIntent.safeParse({
    intentId: a.intentId,
    closeId: Number(a.closeId),
    route,
    amount: a.amount.toString(),
    reason,
    marginRatioBps: a.marginRatioBps,
  });
  return parsed.success ? parsed.data : undefined;
}

export class OnchainIntentWatcher {
  private polling = false;

  constructor(
    private readonly reader: IntentLogReader,
    private readonly cursor: DurableCursor,
    private readonly executor: TreasuryExecutor,
    private readonly options: WatcherOptions,
  ) {}

  async poll(): Promise<PollResult> {
    const result: PollResult = { submitted: 0, refused: 0, malformed: 0 };
    if (this.polling) return result;
    this.polling = true;
    try {
      const head = await this.reader.head();
      const saved = this.cursor.load();
      let next: bigint = saved ?? this.options.startBlock ?? head;
      if (saved === undefined) this.cursor.save(next);
      const safe = head - this.options.confirmations;
      const maxRange = this.options.maxRange ?? DEFAULT_MAX_RANGE;
      while (next <= safe) {
        const last: bigint = next + maxRange - 1n;
        const to: bigint = last < safe ? last : safe;
        const logs = await this.reader.logs(next, to);
        logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
        for (const log of logs) this.handle(log, result);
        next = to + 1n;
        this.cursor.save(next);
      }
    } finally {
      this.polling = false;
    }
    return result;
  }

  private handle(log: IntentLog, result: PollResult): void {
    const intent = decodeIntent(log);
    if (!intent) {
      console.error(`intent log skipped, malformed: block ${log.blockNumber} tx ${log.transactionHash}`);
      result.malformed++;
      return;
    }
    try {
      this.executor.submit(intent);
      result.submitted++;
    } catch (error) {
      if (!(error instanceof IntentRejected)) throw error;
      const reason = error instanceof RouteUnavailable ? `route not available: ${error.message}` : error.message;
      console.error(`intent ${intent.intentId} refused: ${reason}`);
      this.executor.recordRefused(intent, reason);
      result.refused++;
    }
  }
}
