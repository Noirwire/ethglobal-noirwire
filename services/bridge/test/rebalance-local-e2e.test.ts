import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TreasuryExecutor } from "../src/executor.ts";
import { LOCAL_DEPLOYMENT, localChainReachable, setupLocalArc } from "../src/local-arc.ts";
import { AcceptingFundingVerifier, RebalanceBook } from "../src/rebalance.ts";
import { createBridgeServer } from "../src/server.ts";
import { TransferStore } from "../src/transfers.ts";

const PORT = 8555;
const RPC = `http://127.0.0.1:${PORT}`;
const vaultOut = fileURLToPath(new URL("../../../contracts/vault/out/HookExecutor.sol/HookExecutor.json", import.meta.url));
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasContracts = existsSync(LOCAL_DEPLOYMENT) || existsSync(vaultOut);
const TOKEN = "t".repeat(40);
const AMOUNT = "250000000";

describe.skipIf(!hasAnvil || !hasContracts)("maker rebalance requests, local mode", () => {
  let anvil: ChildProcess | undefined;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 50 && !(await localChainReachable(RPC)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 15_000);

  afterAll(() => {
    if (anvil?.pid) process.kill(anvil.pid);
  });

  it("walks a transfer out and a transfer in through the HTTP contract", async () => {
    const arc = await setupLocalArc(RPC, { deployIfMissing: true });
    const store = new TransferStore();
    const executor = new TreasuryExecutor(
      store,
      arc.attester,
      { "solana-hypercore": arc.rebalance.out.adapter, "hypercore-solana": arc.rebalance.in.adapter },
      {
        routes: { "solana-hypercore": arc.rebalance.out.route, "hypercore-solana": arc.rebalance.in.route },
        allowlist: new Set([arc.rebalance.out.route.destination, arc.rebalance.in.route.destination].map((entry) => entry.toLowerCase())),
        dailyCap: 10_000_000_000n,
        defaultPerTransferCap: 1_000_000_000n,
        stuckTimeoutMs: 60_000,
        stuckRetryMs: 5_000,
      },
    );
    const book = new RebalanceBook(executor, store, { bridgeAta: arc.rebalance.bridgeAta, verifier: new AcceptingFundingVerifier() });
    const server = createBridgeServer(store, executor, undefined, undefined, undefined, { book, token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const request = (id: string, direction: "out" | "in", seq: number) => ({
      requestId: id,
      direction,
      amount: AMOUNT,
      requestedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
      seq,
    });
    const until = async (id: string, expected: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        await book.tick();
        await executor.tick();
        const { state } = (await (await call("GET", `/v1/rebalance/requests/${id}`)).json()) as { state: string };
        if (state === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`${id} never reached ${expected}`);
    };

    try {
      const start = arc.rebalance.hyperCore.balance;
      const out = await call("POST", "/v1/rebalance/requests", request("local-out-0001", "out", 1));
      expect(out.status).toBe(202);
      expect(await out.json()).toEqual({ bridgeAta: arc.rebalance.bridgeAta });
      expect((await call("POST", "/v1/rebalance/requests/local-out-0001/funded", { signature: "3".repeat(88) })).status).toBe(202);
      await until("local-out-0001", "credited");
      expect(arc.rebalance.hyperCore.balance).toBe(start + BigInt(AMOUNT) - 500n);

      expect((await call("POST", "/v1/rebalance/requests", request("local-in-00001", "in", 2))).status).toBe(202);
      await until("local-in-00001", "wallet-credited");
      expect(arc.rebalance.hyperCore.balance).toBe(start + BigInt(AMOUNT) - 500n - BigInt(AMOUNT));
      expect(store.inFlight()).toHaveLength(0);
      expect(store.list().map((transfer) => transfer.attester)).toEqual(["local-test-attester", "local-test-attester"]);
    } finally {
      server.close();
    }
  }, 60_000);
});
