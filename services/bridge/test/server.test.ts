import type { AddressInfo } from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { TreasuryExecutor, type RouteAdapter } from "../src/executor.ts";
import { LocalAttester } from "../src/iris.ts";
import { createBridgeServer, IntentFileWatcher } from "../src/server.ts";
import { TransferStore } from "../src/transfers.ts";
import { newTransfer, tempJournal, word } from "./helpers.ts";

const idleAdapter: RouteAdapter = {
  burn: async () => {
    throw new Error("not under test");
  },
  messageFor: async () => undefined,
  deliver: async () => ({ status: "pending", reason: "idle" }),
};

function setup() {
  const store = new TransferStore();
  const attester = new LocalAttester([`0x${"11".repeat(32)}`]);
  const executor = new TreasuryExecutor(store, attester, { "arc-solana": idleAdapter }, {
    routes: { "arc-solana": { destination: "Maker", maxFee: 1n } },
    allowlist: new Set(["maker"]),
    dailyCap: 10_000_000n,
    defaultPerTransferCap: 5_000_000n,
    stuckTimeoutMs: 60_000,
    stuckRetryMs: 5_000,
  });
  const server = createBridgeServer(store, executor);
  return { store, executor, server };
}

const open: ReturnType<typeof createBridgeServer>[] = [];

async function listen(server: ReturnType<typeof createBridgeServer>): Promise<string> {
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

describe("HTTP API", () => {
  it("lists in-flight transfers and fetches one by id", async () => {
    const { store, server } = setup();
    store.create(newTransfer({ transferId: "a" }));
    store.create(newTransfer({ transferId: "b" }));
    store.transition("b", "failed");
    const base = await listen(server);
    const inFlight = (await (await fetch(`${base}/v1/transfers?state=in-flight`)).json()) as { transferId: string }[];
    expect(inFlight.map((t) => t.transferId)).toEqual(["a"]);
    expect(((await (await fetch(`${base}/v1/transfers/b`)).json()) as { state: string }).state).toBe("failed");
    expect((await fetch(`${base}/v1/transfers/missing`)).status).toBe(404);
  });

  it("accepts a valid intent and rejects invalid and disallowed ones", async () => {
    const { server, store } = setup();
    const base = await listen(server);
    const intent = {
      intentId: word(5),
      closeId: 2,
      route: "arc-solana",
      amount: "6000000",
      reason: "solana-rebalance",
      marginRatioBps: 0,
    };
    const post = (body: unknown) =>
      fetch(`${base}/v1/intents`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const accepted = await post(intent);
    expect(accepted.status).toBe(202);
    expect(store.list().map((t) => t.grossAmount)).toEqual(["5000000", "1000000"]);
    expect((await post({ nope: 1 })).status).toBe(400);
    expect((await post({ ...intent, intentId: word(6), amount: "999999999" })).status).toBe(422);
  });

  it("serves /v1/dev/deposit only when a dev deposit handler is wired", async () => {
    const { store, executor, server } = setup();
    const plain = await listen(server);
    expect((await fetch(`${plain}/v1/dev/deposit`, { method: "POST" })).status).toBe(404);

    const seen: (bigint | undefined)[] = [];
    const dev = createBridgeServer(store, executor, (amount) => {
      seen.push(amount);
      return { transfers: [], beneficiary: "0xabc" };
    });
    const base = await listen(dev);
    const empty = await fetch(`${base}/v1/dev/deposit`, { method: "POST" });
    expect(empty.status).toBe(202);
    expect(((await empty.json()) as { beneficiary: string }).beneficiary).toBe("0xabc");
    const sized = await fetch(`${base}/v1/dev/deposit`, { method: "POST", body: JSON.stringify({ amount: "2000000" }) });
    expect(sized.status).toBe(202);
    expect((await fetch(`${base}/v1/dev/deposit`, { method: "POST", body: JSON.stringify({ amount: "-1" }) })).status).toBe(400);
    expect(seen).toEqual([undefined, 2_000_000n]);
  });

  it("streams transfer FlowEvents over SSE", async () => {
    const { server, store } = setup();
    const base = await listen(server);
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    store.create(newTransfer({ transferId: "sse" }));
    const { value } = await reader.read();
    controller.abort();
    const line = new TextDecoder().decode(value).split("\n").find((l) => l.startsWith("data: "))!;
    const event = JSON.parse(line.slice(6)) as { kind: string; transfer: { transferId: string } };
    expect(event.kind).toBe("transfer");
    expect(event.transfer.transferId).toBe("sse");
  });
});

describe("FlowEvent intent file", () => {
  it("submits intent lines once, ignoring other kinds and partial lines", () => {
    const { executor, store } = setup();
    const path = tempJournal();
    const event = {
      kind: "intent",
      at: "2026-11-06T10:00:00.000Z",
      intent: { intentId: word(9), closeId: 1, route: "arc-solana", amount: "1000000", reason: "solana-rebalance", marginRatioBps: 0 },
    };
    writeFileSync(path, `${JSON.stringify({ kind: "fill" })}\n${JSON.stringify(event)}\n{"kind":"int`);
    const watcher = new IntentFileWatcher(path, executor);
    expect(watcher.poll()).toBe(1);
    expect(watcher.poll()).toBe(0);
    appendFileSync(path, `ent"}\n`);
    expect(watcher.poll()).toBe(0);
    expect(store.list()).toHaveLength(1);
  });
});
