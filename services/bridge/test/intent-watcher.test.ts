import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TreasuryExecutor, type ExecutorConfig } from "../src/executor.ts";
import {
  DurableCursor,
  OnchainIntentWatcher,
  type IntentLog,
  type IntentLogReader,
  type WatcherOptions,
} from "../src/intent-watcher.ts";
import type { Attester } from "../src/iris.ts";
import { TransferStore } from "../src/transfers.ts";
import { idleAdapter, tempJournal, word } from "./helpers.ts";

const HYPERCORE = "0x00000000000000000000000000000000000000cc";

class FakeReader implements IntentLogReader {
  height = 100n;
  logsByBlock: IntentLog[] = [];
  requested: [bigint, bigint][] = [];

  async head() {
    return this.height;
  }
  async logs(from: bigint, to: bigint) {
    this.requested.push([from, to]);
    return this.logsByBlock.filter((log) => log.blockNumber >= from && log.blockNumber <= to).map((log) => ({ ...log }));
  }
}

function log(block: bigint, id: number, overrides: Partial<IntentLog["args"]> = {}, logIndex = 0): IntentLog {
  return {
    blockNumber: block,
    logIndex,
    transactionHash: `0xtx${id}`,
    args: {
      intentId: word(id),
      closeId: 7n,
      route: 0,
      amount: 250_000_000n,
      marginRatioBps: 11000,
      reason: 0,
      ...overrides,
    },
  };
}

function stack(journal = tempJournal(), cursorFile = join(dirname(journal), "cursor.json")) {
  const store = new TransferStore(journal);
  const attester: Attester = { label: "local-test-attester", fetchAttestation: async () => ({ status: "pending" }) };
  const config: ExecutorConfig = {
    routes: { "arc-hypercore": { destination: HYPERCORE, maxFee: 300_000n } },
    allowlist: new Set([HYPERCORE]),
    dailyCap: 50_000_000_000n,
    defaultPerTransferCap: 1_000_000_000n,
    stuckTimeoutMs: 600_000,
    stuckRetryMs: 5_000,
  };
  const executor = new TreasuryExecutor(store, attester, { "arc-hypercore": idleAdapter }, config);
  const watcher = (reader: IntentLogReader, options: Partial<WatcherOptions> = {}) =>
    new OnchainIntentWatcher(reader, new DurableCursor(cursorFile), executor, { confirmations: 0n, ...options });
  return { journal, cursorFile, store, executor, watcher };
}

const cursorOf = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { nextBlock: string }).nextBlock;

describe("onchain intent watcher", () => {
  it("starts at the current head on a first run instead of replaying history", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(50n, 1)];
    const result = await s.watcher(reader).poll();
    expect(result.submitted).toBe(0);
    expect(cursorOf(s.cursorFile)).toBe("101");
    expect(s.store.list()).toHaveLength(0);
  });

  it("submits each event once, advances the cursor and does not rescan old blocks", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(105n, 1), log(106n, 2)];
    const watcher = s.watcher(reader, { startBlock: 100n });
    reader.height = 110n;
    const first = await watcher.poll();
    expect(first.submitted).toBe(2);
    expect(s.store.list()).toHaveLength(2);
    expect(cursorOf(s.cursorFile)).toBe("111");

    reader.requested = [];
    const second = await watcher.poll();
    expect(second.submitted).toBe(0);
    expect(reader.requested).toEqual([]);
  });

  it("survives a restart: the cursor is read from disk and replayed events create nothing new", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(105n, 1)];
    reader.height = 110n;
    await s.watcher(reader, { startBlock: 100n }).poll();
    expect(s.store.list()).toHaveLength(1);

    const restarted = stack(s.journal, s.cursorFile);
    reader.requested = [];
    reader.height = 120n;
    reader.logsByBlock.push(log(115n, 2));
    const result = await restarted.watcher(reader).poll();
    expect(reader.requested).toEqual([[111n, 120n]]);
    expect(result.submitted).toBe(1);
    expect(restarted.store.list()).toHaveLength(2);

    writeFileSync(s.cursorFile, JSON.stringify({ nextBlock: "100" }));
    const replay = await stack(s.journal, s.cursorFile).watcher(reader).poll();
    expect(replay.submitted).toBe(2);
    expect(stack(s.journal, s.cursorFile).store.list()).toHaveLength(2);
  });

  it("never creates a second transfer for the same intent seen twice", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(105n, 1), log(105n, 1, {}, 1), log(106n, 1)];
    reader.height = 110n;
    await s.watcher(reader, { startBlock: 100n }).poll();
    expect(s.store.list().map((t) => t.transferId)).toEqual([`${word(1)}:0`]);
  });

  it("skips malformed logs, counts them and keeps going", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [
      log(101n, 1, { route: 9 }),
      log(102n, 2, { reason: 9 }),
      { ...log(103n, 3), args: { intentId: word(3) } },
      log(104n, 4, { closeId: 2n ** 60n }),
      log(105n, 5),
    ];
    reader.height = 110n;
    const result = await s.watcher(reader, { startBlock: 100n }).poll();
    expect(result).toMatchObject({ submitted: 1, malformed: 4 });
    expect(s.store.list().map((t) => t.transferId)).toEqual([`${word(5)}:0`]);
    expect(cursorOf(s.cursorFile)).toBe("111");
  });

  it("waits the configured confirmation depth before reading a block", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(108n, 1)];
    reader.height = 110n;
    const watcher = s.watcher(reader, { startBlock: 100n, confirmations: 5n });
    const early = await watcher.poll();
    expect(early.submitted).toBe(0);
    expect(reader.requested).toEqual([[100n, 105n]]);
    expect(cursorOf(s.cursorFile)).toBe("106");

    reader.height = 114n;
    const later = await watcher.poll();
    expect(later.submitted).toBe(1);
    expect(reader.requested.at(-1)).toEqual([106n, 109n]);
  });

  it("reads long ranges in bounded pages", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.height = 25n;
    await s.watcher(reader, { startBlock: 0n, maxRange: 10n }).poll();
    expect(reader.requested).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);
  });

  it("records an intent on a route with no adapter as not available and keeps watching", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(101n, 1, { route: 1, reason: 2 }), log(102n, 2)];
    reader.height = 110n;
    const result = await s.watcher(reader, { startBlock: 100n }).poll();
    expect(result).toMatchObject({ submitted: 1, refused: 1 });
    const refused = s.store.get(`${word(1)}:0`);
    expect(refused?.state).toBe("failed");
    expect(refused?.error).toMatch(/^route not available/);
    expect(s.store.get(`${word(2)}:0`)?.state).toBe("requested");
  });

  it("does not move the cursor when the executor fails unexpectedly", async () => {
    const s = stack();
    const reader = new FakeReader();
    reader.logsByBlock = [log(105n, 1)];
    reader.height = 110n;
    const watcher = s.watcher(reader, { startBlock: 100n });
    s.executor.submit = () => {
      throw new Error("disk full");
    };
    await expect(watcher.poll()).rejects.toThrow("disk full");
    expect(cursorOf(s.cursorFile)).toBe("100");
  });

  it("refuses to guess when the cursor file is corrupt", async () => {
    const s = stack();
    writeFileSync(s.cursorFile, "{not json");
    await expect(s.watcher(new FakeReader()).poll()).rejects.toThrow();
    writeFileSync(s.cursorFile, JSON.stringify({ nextBlock: "abc" }));
    await expect(s.watcher(new FakeReader()).poll()).rejects.toThrow(/unreadable/);
  });

  it("writes the cursor through a temp file that is renamed away", async () => {
    const s = stack();
    new DurableCursor(s.cursorFile).save(42n);
    expect(cursorOf(s.cursorFile)).toBe("42");
    expect(existsSync(`${s.cursorFile}.tmp`)).toBe(false);
  });
});
