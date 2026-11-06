import { CCTP_DOMAINS, CCTP_TESTNET_CONTRACTS, EVM_FUNDING_SOURCES } from "@noirwire/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { TreasuryExecutor } from "../src/executor.ts";
import {
  EVM_DEPOSIT_ROUTES,
  EvmDeposits,
  type EvmSourceReader,
  type ObservedBurn,
} from "../src/evm-deposit.ts";
import { encodeVaultHookData } from "../src/hooks.ts";
import { LocalAttester } from "../src/iris.ts";
import { addressToBytes32, ZERO_BYTES32 } from "../src/message.ts";
import { createBridgeServer } from "../src/server.ts";
import { TransferStore } from "../src/transfers.ts";
import { DEFAULT_HOOK_EXECUTOR, DEPOSITOR, SOURCE_BENEFICIARY, SOURCES, sourceMessage } from "./evm-fixtures.ts";
import { closeServers, idleAdapter, listen, tempJournal } from "./helpers.ts";

const LOCAL_MESSENGER: Hex = CCTP_TESTNET_CONTRACTS.tokenMessengerV2;
const BASE_TX = `0x${"ab".repeat(32)}`;

const sources = SOURCES;
const BENEFICIARY = SOURCE_BENEFICIARY;
const HOOK_EXECUTOR = DEFAULT_HOOK_EXECUTOR;

class FakeSource implements EvmSourceReader {
  observed = new Map<string, ObservedBurn>();
  asked: string[] = [];

  async burnTransaction(domain: number, txHash: Hex) {
    this.asked.push(`${domain}:${txHash}`);
    return this.observed.get(`${domain}:${txHash}`) ?? null;
  }
}

function setup() {
  const store = new TransferStore(tempJournal());
  const adapters = Object.fromEntries(Object.values(EVM_DEPOSIT_ROUTES).map((route) => [route, idleAdapter]));
  const routes = Object.fromEntries(Object.values(EVM_DEPOSIT_ROUTES).map((route) => [route, { destination: HOOK_EXECUTOR, maxFee: 1_000_000n }]));
  const executor = new TreasuryExecutor(store, new LocalAttester([`0x${"11".repeat(32)}`]), adapters, {
    routes,
    allowlist: new Set([HOOK_EXECUTOR.toLowerCase()]),
    dailyCap: 100_000_000n,
    defaultPerTransferCap: 20_000_000n,
    stuckTimeoutMs: 60_000,
    stuckRetryMs: 5_000,
  });
  const reader = new FakeSource();
  const deposits = new EvmDeposits(reader, executor, store, { hookExecutor: HOOK_EXECUTOR, localTokenMessenger: LOCAL_MESSENGER, sources });
  return { store, executor, reader, deposits };
}

const burned = (...messages: Hex[]): ObservedBurn => ({ failed: false, messages });

describe("EvmDeposits.register", () => {
  it.each(Object.values(EVM_FUNDING_SOURCES).map((source) => [source.label, source.cctpDomain] as const))(
    "adopts a verified %s burn as a burned transfer on its own route",
    async (_label, domain) => {
      const { deposits, reader, store } = setup();
      reader.observed.set(`${domain}:${BASE_TX}`, burned(sourceMessage(domain)));
      const transfer = await deposits.register(domain, BASE_TX);
      expect(transfer).toMatchObject({
        route: EVM_DEPOSIT_ROUTES[domain],
        state: "burned",
        burnTx: BASE_TX,
        grossAmount: "3000000",
        maxFee: "2000",
        sourceDomain: domain,
        destinationDomain: CCTP_DOMAINS.arc,
      });
      expect(transfer.beneficiary?.toLowerCase()).toBe(BENEFICIARY.toLowerCase());
      expect(store.list()).toHaveLength(1);
    },
  );

  it("is idempotent: a retry returns the same transfer without asking the source chain again", async () => {
    const { deposits, reader, store } = setup();
    reader.observed.set(`6:${BASE_TX}`, burned(sourceMessage(6)));
    const first = await deposits.register(6, BASE_TX);
    const again = await deposits.register(6, BASE_TX.toUpperCase().replace("0X", "0x"));
    expect(again.transferId).toBe(first.transferId);
    expect(reader.asked).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it("survives a restart: the transfer is read back from the journal", async () => {
    const journal = tempJournal();
    const reader = new FakeSource();
    reader.observed.set(`3:${BASE_TX}`, burned(sourceMessage(3)));
    const build = () => {
      const store = new TransferStore(journal);
      const executor = new TreasuryExecutor(
        store,
        new LocalAttester([`0x${"11".repeat(32)}`]),
        { "arbitrum-arc": idleAdapter },
        {
          routes: { "arbitrum-arc": { destination: HOOK_EXECUTOR, maxFee: 1n } },
          allowlist: new Set(),
          dailyCap: 100_000_000n,
          defaultPerTransferCap: 20_000_000n,
          stuckTimeoutMs: 60_000,
          stuckRetryMs: 5_000,
        },
      );
      return new EvmDeposits(reader, executor, store, { hookExecutor: HOOK_EXECUTOR, localTokenMessenger: LOCAL_MESSENGER, sources });
    };
    await build().register(3, BASE_TX);
    const after = await build().register(3, BASE_TX);
    expect(after.state).toBe("burned");
    expect(reader.asked).toHaveLength(1);
  });

  it("reports an unseen transaction as not found and a failed one as refused", async () => {
    const { deposits, reader } = setup();
    await expect(deposits.register(0, BASE_TX)).rejects.toThrow("not visible on Ethereum Sepolia yet");
    reader.observed.set(`0:${BASE_TX}`, { failed: true, messages: [] });
    await expect(deposits.register(0, BASE_TX)).rejects.toThrow("nothing was burned");
  });

  it("refuses an unsupported domain and a transaction with no burn", async () => {
    const { deposits, reader } = setup();
    await expect(deposits.register(CCTP_DOMAINS.solana, BASE_TX)).rejects.toThrow("not supported");
    reader.observed.set(`0:${BASE_TX}`, burned());
    await expect(deposits.register(0, BASE_TX)).rejects.toThrow("not a deposit");
  });

  it("refuses burns the HookExecutor would not credit", async () => {
    const { deposits, reader } = setup();
    const other: Hex = "0x00000000000000000000000000000000000000ff";
    const depositor = addressToBytes32(DEPOSITOR);
    const bad: [string, Hex][] = [
      ["messenger", sourceMessage(6, { sender: addressToBytes32(other) })],
      ["recipient", sourceMessage(6, { recipient: addressToBytes32(other) })],
      ["caller", sourceMessage(6, { destinationCaller: ZERO_BYTES32 })],
      ["mint", sourceMessage(6, { mintRecipient: addressToBytes32(other) })],
      ["token", sourceMessage(6, { burnToken: addressToBytes32(EVM_FUNDING_SOURCES.arbitrumSepolia.usdc) })],
      ["destination", sourceMessage(6, { destinationDomain: CCTP_DOMAINS.solana })],
      ["hook", sourceMessage(6, { hookData: "0x1234" })],
      [
        "depositor",
        sourceMessage(6, { hookData: encodeVaultHookData({ beneficiary: BENEFICIARY, solanaDepositor: addressToBytes32(other), deadline: 1n }) }),
      ],
      [
        "beneficiary",
        sourceMessage(6, {
          hookData: encodeVaultHookData({ beneficiary: "0x0000000000000000000000000000000000000000", solanaDepositor: depositor, deadline: 1n }),
        }),
      ],
    ];
    for (const [name, message] of bad) {
      reader.observed.set(`6:0x${name.length.toString(16).padStart(64, "0")}`, burned(message));
      await expect(deposits.register(6, `0x${name.length.toString(16).padStart(64, "0")}`)).rejects.toThrow("not a deposit");
    }
    reader.observed.set(`6:${BASE_TX}`, burned(sourceMessage(6, { sender: addressToBytes32(other) }), sourceMessage(6)));
    expect((await deposits.register(6, BASE_TX)).state).toBe("burned");
  });
});

describe("EVM deposit routes over HTTP", () => {
  afterEach(closeServers);

  it("answers unavailable by default, and refuses to take intents on a depositor-burned route", async () => {
    const { store, executor } = setup();
    const base = await listen(createBridgeServer(store, executor));
    const status = await (await fetch(`${base}/v1/deposits/evm/status`)).json();
    expect(status).toMatchObject({ available: false });
    const submitted = await fetch(`${base}/v1/deposits/evm/submitted`, {
      method: "POST",
      body: JSON.stringify({ domain: 6, txHash: BASE_TX }),
    });
    expect(submitted.status).toBe(409);
    const intent = await fetch(`${base}/v1/intents`, {
      method: "POST",
      body: JSON.stringify({ intentId: BASE_TX, closeId: 1, route: "base-arc", amount: "1000000", reason: "margin-low", marginRatioBps: 1 }),
    });
    expect(intent.status).toBe(422);
  });

  it("registers a burn: 202 with the transfer, 404 while unseen, 422 when refused, 400 for a bad body", async () => {
    const { store, executor, reader, deposits } = setup();
    const base = await listen(createBridgeServer(store, executor, undefined, undefined, undefined, undefined, deposits));
    const post = (body: unknown) => fetch(`${base}/v1/deposits/evm/submitted`, { method: "POST", body: JSON.stringify(body) });

    expect(await (await fetch(`${base}/v1/deposits/evm/status`)).json()).toEqual({ available: true });
    const unseen = await post({ domain: 6, txHash: BASE_TX });
    expect(unseen.status).toBe(404);
    expect(((await unseen.json()) as { error: string }).error).toContain("Base Sepolia");

    reader.observed.set(`6:${BASE_TX}`, burned(sourceMessage(6)));
    const accepted = await post({ domain: 6, txHash: BASE_TX });
    expect(accepted.status).toBe(202);
    const { transfer } = (await accepted.json()) as { transfer: { route: string; state: string } };
    expect(transfer).toMatchObject({ route: "base-arc", state: "burned" });

    const refused = await post({ domain: 5, txHash: BASE_TX });
    expect(refused.status).toBe(422);
    expect((await post({ domain: 6, txHash: "0x12" })).status).toBe(400);
    expect((await post({ txHash: BASE_TX })).status).toBe(400);
  });
});
