import type { AddressInfo } from "node:net";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { bytesToHex, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { TreasuryExecutor } from "../src/executor.ts";
import { decodeVaultHookData } from "../src/hooks.ts";
import { LocalAttester } from "../src/iris.ts";
import { addressToBytes32 } from "../src/message.ts";
import { createBridgeServer } from "../src/server.ts";
import { BURN_WITH_HOOK_OWNER_INDEX, decodeBurnWithHookData, SOLANA_DEVNET_USDC, SOLANA_PROGRAMS } from "../src/solana.ts";
import {
  DepositRefused,
  SolanaDeposits,
  TransactionNotFound,
  UnavailableDeposits,
  type ObservedTransaction,
  type SolanaReader,
} from "../src/solana-deposit.ts";
import { TransferStore } from "../src/transfers.ts";
import { idleAdapter } from "./helpers.ts";

const HOOK_EXECUTOR: Hex = "0x00000000000000000000000000000000000000ee";
const BENEFICIARY: Hex = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MAX_FEE = 1_000n;
const NOW = new Date("2026-11-06T10:00:00.000Z");
const owner = Keypair.generate().publicKey;

class FakeReader implements SolanaReader {
  balance: bigint | null = 50_000_000n;
  observed = new Map<string, ObservedTransaction>();
  asked: string[] = [];

  async latestBlockhash() {
    return { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 900 };
  }

  async tokenBalance(account: PublicKey) {
    this.asked.push(account.toBase58());
    return this.balance;
  }

  async burnTransaction(signature: string) {
    return this.observed.get(signature) ?? null;
  }
}

function setup() {
  const store = new TransferStore();
  const executor = new TreasuryExecutor(store, new LocalAttester([`0x${"11".repeat(32)}`]), { "solana-arc": idleAdapter }, {
    routes: { "solana-arc": { destination: HOOK_EXECUTOR, maxFee: MAX_FEE } },
    allowlist: new Set([HOOK_EXECUTOR.toLowerCase()]),
    dailyCap: 100_000_000n,
    defaultPerTransferCap: 20_000_000n,
    stuckTimeoutMs: 60_000,
    stuckRetryMs: 5_000,
  });
  const reader = new FakeReader();
  const deposits = new SolanaDeposits(reader, executor, {
    hookExecutor: HOOK_EXECUTOR,
    usdcMint: SOLANA_DEVNET_USDC,
    maxFee: MAX_FEE,
    deadlineSeconds: 3600,
    now: () => NOW,
  });
  return { store, executor, reader, deposits };
}

function observe(transactionBase64: string): ObservedTransaction {
  const transaction = Transaction.from(Buffer.from(transactionBase64, "base64"));
  return {
    failed: false,
    instructions: transaction.instructions.map((instruction) => ({
      programId: instruction.programId,
      accounts: instruction.keys.map((key) => key.pubkey),
      data: instruction.data,
    })),
  };
}

const request = { owner: owner.toBase58(), amount: 2_500_000n, beneficiary: BENEFICIARY };

describe("prepare", () => {
  it("returns an unsigned burn with the hook data, recipient, caller and depositor the vault requires", async () => {
    const { deposits, reader } = setup();
    const prepared = await deposits.prepare(request);
    const transaction = Transaction.from(Buffer.from(prepared.transaction, "base64"));

    expect(transaction.feePayer?.equals(owner)).toBe(true);
    expect(transaction.recentBlockhash).toBe(prepared.blockhash);
    expect(transaction.instructions).toHaveLength(1);
    const instruction = transaction.instructions[0]!;
    expect(instruction.programId.equals(SOLANA_PROGRAMS.tokenMessengerMinterV2)).toBe(true);

    const burn = decodeBurnWithHookData(instruction.data)!;
    expect(burn.amount).toBe(2_500_000n);
    expect(burn.destinationDomain).toBe(26);
    expect(burn.mintRecipient).toBe(addressToBytes32(HOOK_EXECUTOR));
    expect(burn.destinationCaller).toBe(addressToBytes32(HOOK_EXECUTOR));
    expect(burn.maxFee).toBe(MAX_FEE);
    expect(burn.minFinalityThreshold).toBe(1000);

    const hook = decodeVaultHookData(burn.hookData);
    expect(hook.version).toBe(1);
    expect(hook.beneficiary.toLowerCase()).toBe(BENEFICIARY.toLowerCase());
    expect(hook.solanaDepositor).toBe(bytesToHex(owner.toBytes()));
    expect(hook.deadline).toBe(BigInt(Math.floor(NOW.getTime() / 1000) + 3600));
    expect(prepared.deadline).toBe(Number(hook.deadline));

    expect(instruction.keys[BURN_WITH_HOOK_OWNER_INDEX]!.pubkey.equals(owner)).toBe(true);
    expect(reader.asked).toEqual([getAssociatedTokenAddressSync(SOLANA_DEVNET_USDC, owner).toBase58()]);
  });

  it("is signed by the fresh event account only, leaving the owner signature empty", async () => {
    const { deposits } = setup();
    const prepared = await deposits.prepare(request);
    const transaction = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    const eventKey = transaction.instructions[0]!.keys.find((key) => key.isSigner && !key.pubkey.equals(owner))!.pubkey;
    const byKey = new Map(transaction.signatures.map((entry) => [entry.publicKey.toBase58(), entry.signature]));
    expect(byKey.get(owner.toBase58())).toBeNull();
    expect(byKey.get(eventKey.toBase58())).toBeInstanceOf(Buffer);
  });

  it("refuses plainly: bad owner, bad beneficiary, no token account, low balance, amounts out of policy", async () => {
    const { deposits, reader } = setup();
    await expect(deposits.prepare({ ...request, owner: "nope" })).rejects.toThrow(DepositRefused);
    await expect(deposits.prepare({ ...request, beneficiary: "0x12" })).rejects.toThrow("beneficiary");
    reader.balance = null;
    await expect(deposits.prepare(request)).rejects.toThrow("no USDC token account");
    reader.balance = 1_000_000n;
    await expect(deposits.prepare(request)).rejects.toThrow("less than the 2500000 requested");
    reader.balance = 999_000_000n;
    await expect(deposits.prepare({ ...request, amount: MAX_FEE })).rejects.toThrow("fee ceiling");
    await expect(deposits.prepare({ ...request, amount: 20_000_001n })).rejects.toThrow("per-transfer cap");
  });
});

describe("register", () => {
  const signature = "5".repeat(88);

  it("adopts a verified burn as a burned solana-arc transfer, once", async () => {
    const { deposits, reader, store } = setup();
    const prepared = await deposits.prepare(request);
    reader.observed.set(signature, observe(prepared.transaction));

    const transfer = await deposits.register(signature);
    expect(transfer).toMatchObject({
      route: "solana-arc",
      state: "burned",
      burnTx: signature,
      grossAmount: "2500000",
      sourceDomain: 5,
      destinationDomain: 26,
      attester: "local-test-attester",
    });
    expect(transfer.beneficiary?.toLowerCase()).toBe(BENEFICIARY.toLowerCase());
    expect((await deposits.register(signature)).transferId).toBe(transfer.transferId);
    expect(store.list()).toHaveLength(1);
  });

  it("reports an unseen transaction as not found and a failed one as refused", async () => {
    const { deposits, reader } = setup();
    await expect(deposits.register(signature)).rejects.toThrow(TransactionNotFound);
    reader.observed.set(signature, { failed: true, instructions: [] });
    await expect(deposits.register(signature)).rejects.toThrow("nothing was burned");
  });

  it("refuses burns that would not credit the vault: foreign recipient, wrong depositor, other programs", async () => {
    const { deposits, reader } = setup();
    const observed = observe((await deposits.prepare(request)).transaction);
    const instruction = observed.instructions[0]!;
    const withData = (mutate: (data: Buffer) => void): ObservedTransaction => {
      const data = Buffer.from(instruction.data);
      mutate(data);
      return { ...observed, instructions: [{ ...instruction, data }] };
    };

    reader.observed.set("recipient", withData((data) => (data[51] = 0x01)));
    await expect(deposits.register("recipient")).rejects.toThrow("not a deposit");

    reader.observed.set("caller", withData((data) => (data[83] = 0x01)));
    await expect(deposits.register("caller")).rejects.toThrow("not a deposit");

    const other = Keypair.generate().publicKey;
    reader.observed.set("depositor", { ...observed, instructions: [{ ...instruction, accounts: instruction.accounts.map((key, i) => (i === BURN_WITH_HOOK_OWNER_INDEX ? other : key)) }] });
    await expect(deposits.register("depositor")).rejects.toThrow("not a deposit");

    reader.observed.set("program", { ...observed, instructions: [{ ...instruction, programId: SOLANA_PROGRAMS.messageTransmitterV2 }] });
    await expect(deposits.register("program")).rejects.toThrow("not a deposit");
  });
});

describe("HTTP", () => {
  const open: ReturnType<typeof createBridgeServer>[] = [];
  afterEach(() => {
    for (const server of open.splice(0)) server.close();
  });

  async function listen(server: ReturnType<typeof createBridgeServer>): Promise<string> {
    open.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("prepares, then registers a submitted signature", async () => {
    const { store, executor, deposits, reader } = setup();
    const base = await listen(createBridgeServer(store, executor, undefined, deposits));
    expect(await (await fetch(`${base}/v1/deposits/solana/status`)).json()).toEqual({ mode: "testnet", available: true });

    const prepare = await post(base, "/v1/deposits/solana/prepare", { owner: owner.toBase58(), amount: "2500000", beneficiary: BENEFICIARY });
    expect(prepare.status).toBe(200);
    const prepared = (await prepare.json()) as { transaction: string };

    const signature = "6".repeat(88);
    expect((await post(base, "/v1/deposits/solana/submitted", { signature })).status).toBe(404);
    reader.observed.set(signature, observe(prepared.transaction));
    const submitted = await post(base, "/v1/deposits/solana/submitted", { signature });
    expect(submitted.status).toBe(202);
    const { transfer } = (await submitted.json()) as { transfer: { route: string; transferId: string } };
    expect(transfer.route).toBe("solana-arc");
    const listed = (await (await fetch(`${base}/v1/transfers`)).json()) as { transferId: string }[];
    expect(listed.map((t) => t.transferId)).toEqual([transfer.transferId]);
  });

  it("maps refusals and bad bodies, and answers 409 when the bridge is local or unconfigured", async () => {
    const { store, executor, deposits } = setup();
    const base = await listen(createBridgeServer(store, executor, undefined, deposits));
    expect((await post(base, "/v1/deposits/solana/prepare", { owner: "x" })).status).toBe(400);
    expect((await post(base, "/v1/deposits/solana/prepare", { owner: owner.toBase58(), amount: "1", beneficiary: BENEFICIARY })).status).toBe(422);
    expect((await post(base, "/v1/deposits/solana/submitted", { signature: "short" })).status).toBe(400);

    const local = await listen(createBridgeServer(store, executor, undefined, new UnavailableDeposits("local", "Use the local simulation")));
    const refused = await post(local, "/v1/deposits/solana/prepare", { owner: owner.toBase58(), amount: "2500000", beneficiary: BENEFICIARY });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("local simulation");
    expect(await (await fetch(`${local}/v1/deposits/solana/status`)).json()).toMatchObject({ mode: "local", available: false });

    const bare = await listen(createBridgeServer(store, executor));
    expect((await post(bare, "/v1/deposits/solana/submitted", { signature: "7".repeat(88) })).status).toBe(409);
  });
});
