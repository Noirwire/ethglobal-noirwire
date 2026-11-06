import { CCTP_DOMAINS, type BridgeTransfer, type TopUpIntent } from "@noirwire/shared";
import {
  concat,
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ArcHypercoreAdapter } from "../src/adapters.ts";
import { BurnRefused, TreasuryExecutor, type ExecutorConfig } from "../src/executor.ts";
import { HypercoreArcAdapter, type BurnLog, type HypercoreArcOptions, type HyperEvmBurns } from "../src/hypercore-arc.ts";
import {
  DEFAULT_LEDGER_MATCH,
  type HyperCoreLedger,
  type LedgerEntry,
  type LedgerMatchConfig,
} from "../src/hyperliquid.ts";
import {
  sendToEvmWithDataDomain,
  sendToEvmWithDataDigest,
  sendToEvmWithDataTypes,
  signSendToEvmWithData,
  type ExchangeResponse,
  type HyperliquidExchange,
  type SendToEvmWithData,
  type SignedExchangeRequest,
} from "../src/hyperliquid-withdraw.ts";
import type { Attestation, Attester } from "../src/iris.ts";
import { addressToBytes32 } from "../src/message.ts";
import { TransferStore } from "../src/transfers.ts";
import { VaultTreasury } from "../src/vault.ts";
import { Crash, FakeVaultChain, MemoryStepLog } from "./fake-vault.ts";
import { buildBurnMessage, tempJournal, word } from "./helpers.ts";

const VAULT: Hex = "0x00000000000000000000000000000000000000bb";
const TREASURY = "0x00000000000000000000000000000000000000aa";
const WALLET: Hex = "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206";
const HYPERCORE_RECIPIENT = "0x00000000000000000000000000000000000000cc";
const NONCE = 1_762_400_000_000;
const AMOUNT = 400_000_000n;
const FEE = 200_000n;
const BURN_TX: Hex = `0x${"ab".repeat(32)}`;
const MINT_TX = `0x${"cd".repeat(32)}`;
const KEY: Hex = `0x${"22".repeat(32)}`;
const account = privateKeyToAccount(KEY);

const action: SendToEvmWithData = {
  hyperliquidChain: "Testnet",
  token: "USDC",
  amount: "10.5",
  sourceDex: "",
  destinationRecipient: VAULT,
  addressEncoding: "hex",
  destinationChainId: 26,
  gasLimit: 200000,
  data: "0x",
  nonce: NONCE,
};

const GOLDEN_R: Hex = "0x57540dd7a25f2a30e2e743778fd70dc840f2e87f0ee5fd6ed7011ef4a6b63463";
const GOLDEN_S: Hex = "0x7c1e8a64763f90c1cbdbf59a59578d0a629a2febb5e362887d72470f49af11ce";
const GOLDEN_V = 28;

const utf8 = (value: string): Hex => keccak256(toBytes(value));

function independentDigest(a: SendToEvmWithData): Hex {
  const domainType = utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainType, utf8("HyperliquidSignTransaction"), utf8("1"), 42161n, "0x0000000000000000000000000000000000000000"],
    ),
  );
  const structType = utf8(
    "HyperliquidTransaction:SendToEvmWithData(string hyperliquidChain,string token,string amount,string sourceDex,string destinationRecipient,string addressEncoding,uint32 destinationChainId,uint64 gasLimit,bytes data,uint64 nonce)",
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        structType,
        utf8(a.hyperliquidChain),
        utf8(a.token),
        utf8(a.amount),
        utf8(a.sourceDex),
        utf8(a.destinationRecipient),
        utf8(a.addressEncoding),
        a.destinationChainId,
        BigInt(a.gasLimit),
        keccak256(a.data),
        BigInt(a.nonce),
      ],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

describe("SendToEvmWithData typed data", () => {
  it("lists the fields in Circle's order with the documented types", () => {
    expect(sendToEvmWithDataTypes["HyperliquidTransaction:SendToEvmWithData"].map((f) => [f.name, f.type])).toEqual([
      ["hyperliquidChain", "string"],
      ["token", "string"],
      ["amount", "string"],
      ["sourceDex", "string"],
      ["destinationRecipient", "string"],
      ["addressEncoding", "string"],
      ["destinationChainId", "uint32"],
      ["gasLimit", "uint64"],
      ["data", "bytes"],
      ["nonce", "uint64"],
    ]);
    expect(sendToEvmWithDataDomain).toEqual({
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 42161,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
    expect(sendToEvmWithDataDigest(action)).toBe(independentDigest(action));
  });

  it("signs a fixed action to a golden signature that an independent digest recovers to the signer", async () => {
    const signed = await signSendToEvmWithData(account, action);
    expect(signed.signature).toEqual({ r: GOLDEN_R, s: GOLDEN_S, v: GOLDEN_V });
    expect(signed.nonce).toBe(NONCE);
    expect(signed.action).toMatchObject({ type: "sendToEvmWithData", signatureChainId: "0xa4b1", nonce: NONCE });

    const recovered = await recoverAddress({
      hash: independentDigest(action),
      signature: { r: signed.signature.r, s: signed.signature.s, v: BigInt(signed.signature.v) },
    });
    expect(recovered).toBe(account.address);
  });
});

class FakeExchange implements HyperliquidExchange {
  posts: SignedExchangeRequest[] = [];
  next: "ok" | "err" | "throw" = "ok";
  async post(request: SignedExchangeRequest): Promise<ExchangeResponse> {
    this.posts.push(request);
    if (this.next === "throw") throw new Error("socket hang up");
    return this.next === "ok" ? { status: "ok" } : { status: "err", reason: "Insufficient margin" };
  }
}

class FakeLedger implements HyperCoreLedger {
  list: LedgerEntry[] = [];
  asked: { user: string; startTime: number }[] = [];
  async entries(user: string, startTime: number): Promise<LedgerEntry[]> {
    this.asked.push({ user, startTime });
    return this.list.filter((entry) => entry.time >= startTime);
  }
}

class FakeBurns implements HyperEvmBurns {
  block = 5_000n;
  logs: BurnLog[] = [];
  async head() {
    return this.block;
  }
  async burnsSince(fromBlock: bigint) {
    return this.logs.filter((log) => log.blockNumber >= fromBlock);
  }
}

class FakeIris implements Attester {
  label = "circle-iris" as const;
  forward: "PENDING" | "COMPLETE" | "FAILED" | undefined;
  askedTx: string[] = [];
  async fetchAttestation(query: { txHash: string; message?: Hex }): Promise<Attestation> {
    this.askedTx.push(query.txHash);
    if (query.txHash !== BURN_TX) return { status: "pending" };
    return {
      status: "complete",
      message: buildBurnMessage({
        sourceDomain: CCTP_DOMAINS.hyperEvm,
        destinationDomain: CCTP_DOMAINS.arc,
        amount: AMOUNT,
        feeExecuted: FEE,
        nonce: word(7),
        mintRecipient: addressToBytes32(VAULT),
      }),
      attestation: "0xabcd",
      forward: this.forward ? { state: this.forward, mintTxHash: MINT_TX } : undefined,
    };
  }
}

function burnLog(overrides: Partial<BurnLog> = {}): BurnLog {
  return {
    transactionHash: BURN_TX,
    blockNumber: 5_001n,
    amount: AMOUNT,
    depositor: WALLET,
    destinationDomain: CCTP_DOMAINS.arc,
    mintRecipient: addressToBytes32(VAULT),
    hookData: "0x",
    ...overrides,
  };
}

function debit(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return { time: NONCE + 500, type: "sendToEvmWithData", amount: AMOUNT, ...overrides };
}

const match: LedgerMatchConfig = { ...DEFAULT_LEDGER_MATCH, debitTypes: [...DEFAULT_LEDGER_MATCH.debitTypes], creditTypes: [...DEFAULT_LEDGER_MATCH.creditTypes], creditCounterparty: WALLET };

function transfer(overrides: Partial<BridgeTransfer> = {}): BridgeTransfer {
  return {
    transferId: `${word(1)}:0`,
    route: "hypercore-arc",
    sourceDomain: CCTP_DOMAINS.hyperEvm,
    destinationDomain: CCTP_DOMAINS.arc,
    grossAmount: AMOUNT.toString(),
    maxFee: "300000",
    state: "requested",
    attester: "circle-iris",
    updatedAt: "2026-11-06T10:00:00.000Z",
    ...overrides,
  } as BridgeTransfer;
}

function adapterRig(journal = new MemoryStepLog()) {
  const exchange = new FakeExchange();
  const ledger = new FakeLedger();
  const burns = new FakeBurns();
  const iris = new FakeIris();
  let fee = FEE;
  let vaultUsdc = 1_000_000n;
  const build = (): HypercoreArcAdapter =>
    new HypercoreArcAdapter({
      account,
      vault: VAULT,
      coreDepositWallet: WALLET,
      hyperliquidChain: "Testnet",
      sourceDex: "",
      gasLimit: 200000,
      match,
      exchange,
      ledger,
      burns,
      fees: { forwardingFee: async () => fee },
      iris,
      vaultBalance: async () => vaultUsdc,
      now: () => NONCE,
    } satisfies HypercoreArcOptions);
  return {
    journal,
    exchange,
    ledger,
    burns,
    iris,
    adapter: build(),
    restart: build,
    setFee: (value: bigint) => (fee = value),
    setVaultUsdc: (value: bigint) => (vaultUsdc = value),
  };
}

describe("hypercore-arc burn", () => {
  it("journals the nonce durably before posting a Circle auto-forwarding withdrawal to the vault", async () => {
    const r = adapterRig();
    const seenByPost: string[] = [];
    const post = r.exchange.post.bind(r.exchange);
    r.exchange.post = async (request) => {
      seenByPost.push(`${r.journal.record?.status}:${r.journal.writes.at(-1)?.durable}`);
      return post(request);
    };
    const { burnTx } = await r.adapter.burn(transfer(), { journal: r.journal });
    expect(seenByPost).toEqual(["armed:true"]);
    expect(burnTx).toBe(`hl:${NONCE}`);
    expect(r.journal.record).toMatchObject({ status: "sent", nonce: String(NONCE), fromBlock: "5000" });
    expect(r.exchange.posts).toHaveLength(1);
    expect(r.exchange.posts[0]?.action).toMatchObject({
      type: "sendToEvmWithData",
      hyperliquidChain: "Testnet",
      token: "USDC",
      amount: "400",
      sourceDex: "",
      destinationRecipient: VAULT,
      addressEncoding: "hex",
      destinationChainId: 26,
      gasLimit: 200000,
      data: "0x",
      nonce: NONCE,
    });
  });

  it("does not post again once the journal says sent", async () => {
    const r = adapterRig();
    await r.adapter.burn(transfer(), { journal: r.journal });
    const again = await r.restart().burn(transfer(), { journal: r.journal });
    expect(again.burnTx).toBe(`hl:${NONCE}`);
    expect(r.exchange.posts).toHaveLength(1);
  });

  it("after a crash between the journal and the POST, resends the same nonce and signature", async () => {
    class CrashAfterArm extends MemoryStepLog {
      override write(record: Parameters<MemoryStepLog["write"]>[0], durable: boolean) {
        super.write(record, durable);
        if (record.status === "armed") throw new Crash("died after journaling");
      }
    }
    const r = adapterRig(new CrashAfterArm());
    await expect(r.adapter.burn(transfer(), { journal: r.journal })).rejects.toThrow(/died after journaling/);
    expect(r.exchange.posts).toHaveLength(0);

    const clean = new MemoryStepLog();
    clean.record = r.journal.record;
    await r.restart().burn(transfer(), { journal: clean });
    expect(r.exchange.posts).toHaveLength(1);
    expect(r.exchange.posts[0]?.nonce).toBe(NONCE);
    expect(clean.record?.status).toBe("sent");
    const expected = await signSendToEvmWithData(account, { ...action, amount: "400", destinationRecipient: VAULT.toLowerCase(), nonce: NONCE });
    expect(r.exchange.posts[0]?.signature).toEqual(expected.signature);
  });

  it("after a crash following the POST, finds the action in the ledger and never signs again", async () => {
    class CrashOnSent extends MemoryStepLog {
      override write(record: Parameters<MemoryStepLog["write"]>[0], durable: boolean) {
        if (record.status === "sent") throw new Crash("died after the POST");
        super.write(record, durable);
      }
    }
    const r = adapterRig(new CrashOnSent());
    await expect(r.adapter.burn(transfer(), { journal: r.journal })).rejects.toThrow(/died after the POST/);
    expect(r.exchange.posts).toHaveLength(1);

    r.ledger.list = [debit()];
    const clean = new MemoryStepLog();
    clean.record = r.journal.record;
    const { burnTx } = await r.restart().burn(transfer(), { journal: clean });
    expect(burnTx).toBe(`hl:${NONCE}`);
    expect(r.exchange.posts).toHaveLength(1);
    expect(clean.record?.status).toBe("sent");
  });

  it("keeps an unknown POST outcome pending on the same nonce and never refuses on a re-sent error", async () => {
    const r = adapterRig();
    r.exchange.next = "throw";
    await expect(r.adapter.burn(transfer(), { journal: r.journal })).rejects.toThrow(/socket hang up/);
    expect(r.journal.record?.status).toBe("armed");

    r.exchange.next = "err";
    const error = await r.restart().burn(transfer(), { journal: r.journal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BurnRefused);
    expect(r.journal.record?.status).toBe("armed");
    expect(new Set(r.exchange.posts.map((p) => p.nonce))).toEqual(new Set([NONCE]));
  });

  it("refuses and journals the refusal when Hyperliquid rejects a first attempt", async () => {
    const r = adapterRig();
    r.exchange.next = "err";
    await expect(r.adapter.burn(transfer(), { journal: r.journal })).rejects.toBeInstanceOf(BurnRefused);
    expect(r.journal.record).toMatchObject({ status: "refused" });
    await expect(r.restart().burn(transfer(), { journal: r.journal })).rejects.toBeInstanceOf(BurnRefused);
    expect(r.exchange.posts).toHaveLength(1);
  });

  it("refuses without signing when the forwarding fee is above the maximum", async () => {
    const r = adapterRig();
    r.setFee(300_001n);
    await expect(r.adapter.burn(transfer(), { journal: r.journal })).rejects.toThrow(/above the 300000 base unit maximum/);
    expect(r.exchange.posts).toHaveLength(0);
    expect(r.journal.record).toBeUndefined();
  });
});

describe("hypercore-arc detection", () => {
  async function sent() {
    const r = adapterRig();
    await r.adapter.burn(transfer(), { journal: r.journal });
    return r;
  }

  it("waits for the ledger debit, then the HyperEVM burn, then returns the real burn hash", async () => {
    const r = await sent();
    await expect(r.adapter.attestationTxHash(transfer(), { journal: r.journal })).rejects.toThrow(/ledger to show the debit/);
    r.ledger.list = [debit()];
    await expect(r.adapter.attestationTxHash(transfer(), { journal: r.journal })).rejects.toThrow(/HyperEVM burn/);
    r.burns.logs = [burnLog({ blockNumber: 4_999n }), burnLog({ destinationDomain: CCTP_DOMAINS.solana })];
    await expect(r.adapter.attestationTxHash(transfer(), { journal: r.journal })).rejects.toThrow(/HyperEVM burn/);
    r.burns.logs.push(burnLog());
    expect(await r.adapter.attestationTxHash(transfer(), { journal: r.journal })).toBe(BURN_TX);
    expect(r.journal.record).toMatchObject({ status: "done", txHash: BURN_TX });
  });

  it("ignores a debit of the wrong size or type and one older than the nonce", async () => {
    const r = await sent();
    r.ledger.list = [debit({ amount: AMOUNT + 5_000_000n }), debit({ type: "deposit" }), debit({ time: NONCE - 120_000 })];
    r.burns.logs = [burnLog()];
    await expect(r.adapter.attestationTxHash(transfer(), { journal: r.journal })).rejects.toThrow(/ledger to show the debit/);
  });

  it("reports forwarded and failed states from Iris", async () => {
    const r = await sent();
    r.ledger.list = [debit()];
    r.burns.logs = [burnLog()];
    await r.adapter.attestationTxHash(transfer(), { journal: r.journal });
    const context = { journal: r.journal };
    expect(await r.adapter.deliver(transfer(), "0x", "0x", context)).toMatchObject({ status: "pending", reason: expect.stringContaining("waiting") });
    r.iris.forward = "FAILED";
    expect(await r.adapter.deliver(transfer(), "0x", "0x", context)).toMatchObject({ status: "pending", reason: expect.stringContaining("failure") });
    r.iris.forward = "COMPLETE";
    expect(await r.adapter.deliver(transfer(), "0x", "0x", context)).toEqual({ status: "done", state: "minted", tx: MINT_TX });
  });
});

const TOTAL_LEDGER = 9_000_000_000n;

function executorRig() {
  const journal = tempJournal();
  const store = new TransferStore(journal);
  const r = adapterRig();
  const chain = new FakeVaultChain(TOTAL_LEDGER);
  const config: ExecutorConfig = {
    routes: { "hypercore-arc": { destination: VAULT, maxFee: 300_000n } },
    allowlist: new Set([VAULT.toLowerCase()]),
    dailyCap: 50_000_000_000n,
    defaultPerTransferCap: 1_000_000_000n,
    stuckTimeoutMs: 600_000,
    stuckRetryMs: 5_000,
    vault: new VaultTreasury(VAULT, TREASURY, chain),
  };
  const executor = new TreasuryExecutor(store, r.iris, { "hypercore-arc": r.adapter }, config);
  return { ...r, store, chain, executor };
}

const returnIntent: TopUpIntent = {
  intentId: word(1),
  closeId: 1,
  route: "hypercore-arc",
  amount: AMOUNT.toString(),
  reason: "surplus-return",
  marginRatioBps: 30000,
};

describe("hypercore-arc through the executor", () => {
  it("walks debit seen, burn found, attested, forwarded and minted to the vault, then acknowledges once", async () => {
    const r = executorRig();
    const [created] = r.executor.submit(returnIntent);
    const id = (created as BridgeTransfer).transferId;
    const states = async () => {
      await r.executor.step(id);
      return r.store.get(id)?.state;
    };

    expect(await states()).toBe("burned");
    expect(r.store.get(id)?.burnTx).toBe(`hl:${NONCE}`);
    expect(await states()).toBe("burned");
    expect(r.executor.pending()).toEqual([]);
    await r.executor.advance(id);
    expect(r.executor.pending()[0]?.reason).toMatch(/ledger to show the debit/);

    r.ledger.list = [debit()];
    await r.executor.advance(id);
    expect(r.executor.pending()[0]?.reason).toMatch(/HyperEVM burn/);

    r.burns.logs = [burnLog()];
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("attested");
    expect(r.iris.askedTx.at(-1)).toBe(BURN_TX);
    expect(r.store.get(id)?.netMinted).toBe((AMOUNT - FEE).toString());

    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("attested");
    r.iris.forward = "COMPLETE";
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("minted");
    expect(r.executor.pending()[0]?.reason).toMatch(/vault USDC balance rose by 0 of the expected/);
    expect(r.chain.sends).toBe(0);

    r.setVaultUsdc(1_000_000n + AMOUNT - FEE);
    r.chain.surplus += AMOUNT - FEE;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("credited");
    expect(r.chain.sends).toBe(1);
    expect(r.chain.ledger).toBe(TOTAL_LEDGER + AMOUNT - FEE);
    expect(r.exchange.posts).toHaveLength(1);

    await r.executor.tick();
    expect(r.chain.sends).toBe(1);
    expect(r.exchange.posts).toHaveLength(1);
  });

  it("marks the transfer failed, with no retry, when the fee is above the maximum", async () => {
    const r = executorRig();
    r.setFee(400_000n);
    const [created] = r.executor.submit(returnIntent);
    const id = (created as BridgeTransfer).transferId;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("failed");
    expect(r.store.get(id)?.error).toMatch(/forwarding fee/);
    expect(r.exchange.posts).toHaveLength(0);
  });

  it("survives a restart after the POST: the new process finds the ledger entry and posts nothing", async () => {
    const r = executorRig();
    r.exchange.next = "throw";
    const [created] = r.executor.submit(returnIntent);
    const id = (created as BridgeTransfer).transferId;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("requested");
    expect(r.store.meta(id)?.withdraw?.status).toBe("armed");

    r.exchange.next = "ok";
    r.ledger.list = [debit()];
    const restartedStore = new TransferStore(r.store === undefined ? undefined : journalOf(r));
    const restarted = new TreasuryExecutor(restartedStore, r.iris, { "hypercore-arc": r.restart() }, {
      routes: { "hypercore-arc": { destination: VAULT, maxFee: 300_000n } },
      allowlist: new Set([VAULT.toLowerCase()]),
      dailyCap: 50_000_000_000n,
      defaultPerTransferCap: 1_000_000_000n,
      stuckTimeoutMs: 600_000,
      stuckRetryMs: 5_000,
      vault: new VaultTreasury(VAULT, TREASURY, r.chain),
    });
    await restarted.step(id);
    expect(restartedStore.get(id)?.state).toBe("burned");
    expect(r.exchange.posts).toHaveLength(1);
  });
});

function journalOf(r: { store: TransferStore }): string {
  return (r.store as unknown as { journalPath: string }).journalPath;
}

describe("HyperCore credit is confirmed by a ledger entry", () => {
  const RECIPIENT = HYPERCORE_RECIPIENT;
  const NET = AMOUNT - FEE;

  function creditRig() {
    const ledger = new FakeLedger();
    let accountValue = 100_000_000n;
    const iris = new FakeIris();
    const evm = {
      depositForBurn: async () => BURN_TX,
      messageFromBurn: async () =>
        buildBurnMessage({
          sourceDomain: CCTP_DOMAINS.arc,
          destinationDomain: CCTP_DOMAINS.hyperEvm,
          amount: 500_000_000n,
          feeExecuted: 250_000n,
          nonce: word(9),
        }),
    };
    const adapter = new ArcHypercoreAdapter(evm as never, iris, {
      forwarder: WALLET,
      recipient: RECIPIENT,
      reader: { balance: async () => accountValue },
      ledger,
      match,
    });
    iris.forward = "COMPLETE";
    const store = new TransferStore();
    const executor = new TreasuryExecutor(store, { label: "circle-iris", fetchAttestation: async (q) => (await iris.fetchAttestation({ ...q, txHash: BURN_TX })) }, { "arc-hypercore": adapter }, {
      routes: { "arc-hypercore": { destination: RECIPIENT, maxFee: 300_000n } },
      allowlist: new Set([RECIPIENT]),
      dailyCap: 50_000_000_000n,
      defaultPerTransferCap: 1_000_000_000n,
      stuckTimeoutMs: 600_000,
      stuckRetryMs: 5_000,
    });
    return { ledger, store, executor, bump: (by: bigint) => (accountValue += by) };
  }

  const intent: TopUpIntent = { ...returnIntent, route: "arc-hypercore", amount: "500000000", reason: "margin-low" };
  const credit = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
    time: Date.now() + 60_000,
    type: "spotTransfer",
    token: "USDC",
    amount: NET,
    user: WALLET,
    destination: RECIPIENT,
    ...overrides,
  });

  async function forwarded() {
    const r = creditRig();
    const [created] = r.executor.submit(intent);
    const id = (created as BridgeTransfer).transferId;
    await r.executor.advance(id);
    expect(r.store.get(id)?.state).toBe("forwarded");
    return { ...r, id };
  }

  it("does not credit on an account value rise alone", async () => {
    const r = await forwarded();
    r.bump(NET);
    await r.executor.advance(r.id);
    expect(r.store.get(r.id)?.state).toBe("forwarded");
    expect(r.executor.pending()[0]?.reason).toMatch(/account value rose but no HyperCore ledger entry/);
  });

  it("rejects an entry of the wrong type, counterparty, destination, size or time", async () => {
    const r = await forwarded();
    r.ledger.list = [
      credit({ type: "deposit" }),
      credit({ user: HYPERCORE_RECIPIENT }),
      credit({ destination: VAULT }),
      credit({ amount: NET + 5_000_000n }),
      credit({ time: 1_000 }),
    ];
    await r.executor.advance(r.id);
    expect(r.store.get(r.id)?.state).toBe("forwarded");
  });

  it("credits when the CoreDepositWallet's spotTransfer to the recipient is in the ledger", async () => {
    const r = await forwarded();
    r.ledger.list = [credit()];
    await r.executor.advance(r.id);
    expect(r.executor.pending()).toEqual([]);
    expect(r.store.get(r.id)?.state).toBe("credited");
  });
});
