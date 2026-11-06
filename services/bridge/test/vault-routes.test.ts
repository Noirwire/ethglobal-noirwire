import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import type { BridgeTransfer, TopUpIntent } from "@noirwire/shared";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { SolanaArcAdapter } from "../src/adapters.ts";
import { IntentForbidden, TreasuryExecutor, type ExecutorConfig } from "../src/executor.ts";
import { LocalAttester } from "../src/iris.ts";
import { createBridgeServer, IntentFileWatcher } from "../src/server.ts";
import type { SolanaDriver } from "../src/solana.ts";
import { TransferStore } from "../src/transfers.ts";
import { VaultTreasury } from "../src/vault.ts";
import { FakeVaultChain } from "./fake-vault.ts";
import { idleAdapter, tempJournal, word } from "./helpers.ts";

const VAULT = "0x00000000000000000000000000000000000000bb";
const HYPERCORE = "0x00000000000000000000000000000000000000cc";

const intent: TopUpIntent = {
  intentId: word(1),
  closeId: 1,
  route: "arc-hypercore",
  amount: "100000000",
  reason: "margin-low",
  marginRatioBps: 9000,
};

function rig() {
  const store = new TransferStore();
  const config: ExecutorConfig = {
    routes: { "arc-hypercore": { destination: HYPERCORE, maxFee: 300_000n } },
    allowlist: new Set([HYPERCORE]),
    dailyCap: 5_000_000_000n,
    defaultPerTransferCap: 1_000_000_000n,
    stuckTimeoutMs: 600_000,
    stuckRetryMs: 5_000,
    vault: new VaultTreasury(VAULT, "0x00000000000000000000000000000000000000aa", new FakeVaultChain(9_000_000_000n)),
  };
  const executor = new TreasuryExecutor(store, new LocalAttester([`0x${"11".repeat(32)}`]), { "arc-hypercore": idleAdapter }, config);
  return { store, executor };
}

const open: ReturnType<typeof createBridgeServer>[] = [];
afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

describe("vault releases come only from the onchain intent", () => {
  it("answers 403 to an HTTP intent on a vault route and creates nothing", async () => {
    const { store, executor } = rig();
    const server = createBridgeServer(store, executor);
    open.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/v1/intents`, { method: "POST", body: JSON.stringify(intent), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/only from the onchain NavReceiver/);
    expect(store.list()).toHaveLength(0);
  });

  it("skips a vault route read from the intent file", () => {
    const { store, executor } = rig();
    const path = tempJournal();
    writeFileSync(path, `${JSON.stringify({ kind: "intent", at: "2026-11-06T10:00:00.000Z", intent })}\n`);
    expect(new IntentFileWatcher(path, executor).poll()).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it("still accepts the same intent from the onchain path", () => {
    const { store, executor } = rig();
    expect(() => executor.submitExternal(intent)).toThrow(IntentForbidden);
    expect(executor.submit(intent)).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });
});

describe("Solana burn amount", () => {
  const OPTIONS = { hookExecutor: "0x00000000000000000000000000000000000000ee", beneficiary: VAULT, solanaDepositor: `0x${"01".repeat(32)}`, deadlineSeconds: 3600 } as const;

  function solanaRig(balance: bigint) {
    const burns: bigint[] = [];
    const solana = {
      usdcBalance: async () => balance,
      burn: async (params: { amount: bigint }) => {
        burns.push(params.amount);
        return { signature: "sig", messageSentEventData: new PublicKey(new Uint8Array(32)) };
      },
    } as unknown as SolanaDriver;
    return { burns, adapter: new SolanaArcAdapter(solana, {} as never, OPTIONS) };
  }

  const transfer = { transferId: "t:0", grossAmount: "7000000", maxFee: "1000" } as BridgeTransfer;

  it("burns exactly the transfer amount even when the account holds more", async () => {
    const { adapter, burns } = solanaRig(90_000_000n);
    expect(await adapter.preflight(transfer)).toBeUndefined();
    await adapter.burn(transfer);
    expect(burns).toEqual([7_000_000n]);
  });

  it("refuses to burn when the account holds less than the amount", async () => {
    const { adapter, burns } = solanaRig(6_999_999n);
    expect(await adapter.preflight(transfer)).toMatch(/holds 6999999 base units, less than the 7000000/);
    expect(burns).toEqual([]);
  });
});
