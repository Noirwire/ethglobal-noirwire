import type { AddressInfo } from "node:net";
import { CCTP_DOMAINS } from "@noirwire/shared";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { SolanaHypercoreAdapter } from "../src/adapters.ts";
import { TreasuryExecutor, type RouteAdapter } from "../src/executor.ts";
import { HypercoreSolanaAdapter, type BurnLog, type HyperEvmBurns } from "../src/hypercore-arc.ts";
import { DEFAULT_LEDGER_MATCH, type HyperCoreLedger, type LedgerEntry, type LedgerMatchConfig } from "../src/hyperliquid.ts";
import type { ExchangeResponse, HyperliquidExchange, SignedExchangeRequest } from "../src/hyperliquid-withdraw.ts";
import type { Attestation, Attester } from "../src/iris.ts";
import { RebalanceBook, SolanaFundingVerifier, type FundingCheck, type FundingVerifier } from "../src/rebalance.ts";
import { createBridgeServer } from "../src/server.ts";
import { SolanaDriver } from "../src/solana.ts";
import { TransferStore } from "../src/transfers.ts";
import { buildBurnMessage, clock, word } from "./helpers.ts";

const TOKEN = "r".repeat(40);
const AMOUNT = 400_000_000n;
const FEE = 200_000n;
const NET = AMOUNT - FEE;
const NONCE = 1_762_400_000_000;
const WALLET: Hex = "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206";
const RECIPIENT: Hex = "0x00000000000000000000000000000000000000cc";
const BURN_TX: Hex = `0x${"ab".repeat(32)}`;
const SIGNATURE = "5".repeat(88);
const OTHER_SIGNATURE = "6".repeat(88);
const account = privateKeyToAccount(`0x${"22".repeat(32)}`);

const match: LedgerMatchConfig = {
  ...DEFAULT_LEDGER_MATCH,
  debitTypes: [...DEFAULT_LEDGER_MATCH.debitTypes],
  creditTypes: [...DEFAULT_LEDGER_MATCH.creditTypes],
  creditCounterparty: WALLET,
};

class FakeLedger implements HyperCoreLedger {
  list: LedgerEntry[] = [];
  async entries(_user: string, startTime: number): Promise<LedgerEntry[]> {
    return this.list.filter((entry) => entry.time >= startTime);
  }
}

class FakeVerifier implements FundingVerifier {
  check: FundingCheck = { status: "found", received: AMOUNT };
  async verify(): Promise<FundingCheck> {
    return this.check;
  }
}

function rig() {
  const time = clock();
  const store = new TransferStore(undefined, time.now);
  const solanaBurns: { destinationDomain: number; amount: bigint }[] = [];
  const received: (PublicKey | undefined)[] = [];
  const solana = new SolanaDriver(new Connection("http://127.0.0.1:9"), Keypair.generate());
  let bridgeBalance = 10n * AMOUNT;
  solana.usdcBalance = async () => bridgeBalance;
  solana.burn = (async (params: { destinationDomain: number; amount: bigint }) => {
    solanaBurns.push(params);
    return { signature: "solburn", messageSentEventData: Keypair.generate().publicKey };
  }) as typeof solana.burn;
  solana.receive = (async (params: { recipient?: PublicKey }) => {
    received.push(params.recipient);
    return "solmint";
  }) as typeof solana.receive;

  const makerOwner = Keypair.generate().publicKey;
  const makerAta = solana.tokenAccount(makerOwner);
  const ledger = new FakeLedger();
  const posts: SignedExchangeRequest[] = [];
  const exchange: HyperliquidExchange = {
    post: async (request): Promise<ExchangeResponse> => {
      posts.push(request);
      return { status: "ok" };
    },
  };
  const burnLogs: BurnLog[] = [];
  const burns: HyperEvmBurns = { head: async () => 5_000n, burnsSince: async () => burnLogs };
  const iris: Attester = {
    label: "circle-iris",
    fetchAttestation: async (query): Promise<Attestation> => {
      if (query.txHash === "solburn") {
        return {
          status: "complete",
          message: buildBurnMessage({ sourceDomain: CCTP_DOMAINS.solana, destinationDomain: CCTP_DOMAINS.hyperEvm, amount: AMOUNT, feeExecuted: FEE }),
          attestation: "0xabcd",
          forward: { state: "COMPLETE", mintTxHash: "0xmint" },
        };
      }
      if (query.txHash === BURN_TX) {
        return {
          status: "complete",
          message: buildBurnMessage({ sourceDomain: CCTP_DOMAINS.hyperEvm, destinationDomain: CCTP_DOMAINS.solana, amount: AMOUNT, feeExecuted: FEE }),
          attestation: "0xabcd",
        };
      }
      return { status: "pending" };
    },
  };
  const forward = { forwarder: WALLET, recipient: RECIPIENT, reader: { balance: async () => 0n }, ledger, match };
  const arcBurns: string[] = [];
  const arcStub: RouteAdapter = {
    burn: async (transfer) => {
      arcBurns.push(transfer.transferId);
      return { burnTx: "arc-burn" };
    },
    messageFor: async () => undefined,
    deliver: async () => ({ status: "pending", reason: "idle" }),
    destinationBalance: async () => 0n,
  };
  const adapters = {
    "solana-hypercore": new SolanaHypercoreAdapter(solana, iris, forward),
    "hypercore-solana": new HypercoreSolanaAdapter({
      account,
      coreDepositWallet: WALLET,
      hyperliquidChain: "Testnet",
      sourceDex: "",
      gasLimit: 200000,
      match,
      exchange,
      ledger,
      burns,
      iris,
      solana,
      makerOwner,
      now: () => NONCE,
    }),
    "arc-hypercore": arcStub,
  };
  const executor = new TreasuryExecutor(
    store,
    iris,
    adapters,
    {
      routes: {
        "solana-hypercore": { destination: RECIPIENT, maxFee: 300_000n },
        "hypercore-solana": { destination: makerAta.toBase58(), maxFee: 300_000n },
        "arc-hypercore": { destination: "0xarc", maxFee: 300_000n },
      },
      allowlist: new Set([RECIPIENT, makerAta.toBase58().toLowerCase(), "0xarc"]),
      dailyCap: 10_000_000_000n,
      defaultPerTransferCap: 1_000_000_000n,
      stuckTimeoutMs: 30 * 60_000,
      stuckRetryMs: 60_000,
    },
    time.now,
  );
  const verifier = new FakeVerifier();
  const book = new RebalanceBook(executor, store, { bridgeAta: solana.tokenAccount().toBase58(), verifier, now: time.now });
  const body = (overrides: Record<string, unknown> = {}) => ({
    requestId: "req-00000001",
    direction: "out",
    amount: AMOUNT.toString(),
    requestedAt: time.now().toISOString(),
    validUntil: new Date(time.now().getTime() + 10 * 60_000).toISOString(),
    seq: 1,
    ...overrides,
  });
  const run = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await book.tick();
      await executor.tick();
    }
  };
  const credit = () => {
    ledger.list.push({
      time: time.now().getTime() + 1000,
      type: "spotTransfer",
      token: "USDC",
      user: WALLET,
      destination: RECIPIENT,
      amount: NET,
    });
  };
  const debitAndBurn = () => {
    ledger.list.push({ time: NONCE + 500, type: "sendToEvmWithData", amount: AMOUNT });
    burnLogs.push({
      transactionHash: BURN_TX,
      blockNumber: 5_001n,
      amount: AMOUNT,
      depositor: WALLET,
      destinationDomain: CCTP_DOMAINS.solana,
      mintRecipient: bytesToHex(makerAta.toBytes()),
      hookData: "0x",
    });
  };
  return {
    time, store, solana, solanaBurns, received, makerOwner, makerAta, posts, executor, book, verifier, body, run, credit, debitAndBurn,
    arcBurns, setBridgeBalance: (value: bigint) => (bridgeBalance = value),
  };
}

const open: ReturnType<typeof createBridgeServer>[] = [];

async function serve(r: ReturnType<typeof rig>): Promise<string> {
  const server = createBridgeServer(r.store, r.executor, undefined, undefined, undefined, { book: r.book, token: TOKEN });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

const post = (base: string, path: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (base: string, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

describe("POST /v1/rebalance/requests", () => {
  it("requires the rebalance token, which is not the bridge token", async () => {
    const r = rig();
    const base = await serve(r);
    expect((await post(base, "/v1/rebalance/requests", r.body(), null)).status).toBe(401);
    expect((await post(base, "/v1/rebalance/requests", r.body(), "x".repeat(40))).status).toBe(401);
    expect((await get(base, "/v1/rebalance/requests/req-00000001")).status).toBe(404);
  });

  it("answers 202 with the bridge account and is idempotent on the request id", async () => {
    const r = rig();
    const base = await serve(r);
    const first = await post(base, "/v1/rebalance/requests", r.body());
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { bridgeAta: string };
    expect(accepted.bridgeAta).toBe(r.solana.tokenAccount().toBase58());
    const again = await post(base, "/v1/rebalance/requests", r.body());
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual(accepted);
    const state = (await (await get(base, "/v1/rebalance/requests/req-00000001")).json()) as { state: string };
    expect(state.state).toBe("awaiting-funds");
  });

  it("answers 409 for a reused id with other terms and 422 for invalid requests", async () => {
    const r = rig();
    const base = await serve(r);
    await post(base, "/v1/rebalance/requests", r.body());
    expect((await post(base, "/v1/rebalance/requests", r.body({ amount: "1000000000" }))).status).toBe(409);
    expect((await post(base, "/v1/rebalance/requests", r.body({ requestId: "req-00000002", direction: "sideways" }))).status).toBe(422);
    expect((await post(base, "/v1/rebalance/requests", r.body({ requestId: "req-00000003", amount: "100000" }))).status).toBe(422);
    expect((await post(base, "/v1/rebalance/requests", r.body({ requestId: "req-00000004", validUntil: "2020-01-01T00:00:00.000Z" }))).status).toBe(422);
  });
});

describe("a transfer out (solana-hypercore)", () => {
  it("waits for the funding, then burns on Solana toward HyperEVM and credits HyperCore", async () => {
    const r = rig();
    const base = await serve(r);
    await post(base, "/v1/rebalance/requests", r.body());
    await r.run();
    expect(r.solanaBurns).toHaveLength(0);

    const funded = await post(base, "/v1/rebalance/requests/req-00000001/funded", { signature: SIGNATURE });
    expect(funded.status).toBe(202);
    await r.run();
    expect(r.solanaBurns).toEqual([expect.objectContaining({ destinationDomain: CCTP_DOMAINS.hyperEvm, amount: AMOUNT })]);
    expect(r.book.state("req-00000001")).toBe("in-progress");

    r.credit();
    await r.run();
    expect(r.book.state("req-00000001")).toBe("credited");
    expect(r.store.forIntent("req-00000001")[0]?.route).toBe("solana-hypercore");
  });

  it("refuses a funding transaction that moved less than the amount and burns nothing", async () => {
    const r = rig();
    r.verifier.check = { status: "found", received: AMOUNT - 1n };
    r.book.accept(r.body());
    await r.book.funded("req-00000001", SIGNATURE);
    await r.run();
    expect(r.book.state("req-00000001")).toBe("failed");
    expect(r.solanaBurns).toHaveLength(0);
  });

  it("keeps waiting while the funding transaction is not found, then gives up", async () => {
    const r = rig();
    r.verifier.check = { status: "missing" };
    r.book.accept(r.body());
    await r.book.funded("req-00000001", SIGNATURE);
    expect(r.book.state("req-00000001")).toBe("verifying-funds");
    r.time.advance(11 * 60_000);
    await r.book.tick();
    expect(r.book.state("req-00000001")).toBe("failed");
  });

  it("rejects a funding call for an unknown request, an in request, a second signature or a reused one", async () => {
    const r = rig();
    const base = await serve(r);
    expect((await post(base, "/v1/rebalance/requests/nope/funded", { signature: SIGNATURE })).status).toBe(404);
    await post(base, "/v1/rebalance/requests", r.body({ requestId: "req-in-000001", direction: "in", seq: 2 }));
    expect((await post(base, "/v1/rebalance/requests/req-in-000001/funded", { signature: SIGNATURE })).status).toBe(409);
    await post(base, "/v1/rebalance/requests", r.body());
    expect((await post(base, "/v1/rebalance/requests/req-00000001/funded", { signature: "bad" })).status).toBe(422);
    expect((await post(base, "/v1/rebalance/requests/req-00000001/funded", { signature: SIGNATURE })).status).toBe(202);
    expect((await post(base, "/v1/rebalance/requests/req-00000001/funded", { signature: SIGNATURE })).status).toBe(202);
    expect((await post(base, "/v1/rebalance/requests/req-00000001/funded", { signature: OTHER_SIGNATURE })).status).toBe(409);
    await post(base, "/v1/rebalance/requests", r.body({ requestId: "req-00000009", seq: 3 }));
    expect((await post(base, "/v1/rebalance/requests/req-00000009/funded", { signature: SIGNATURE })).status).toBe(409);
  });

  it("ends expired when it was never funded in time, and refuses a late funding call", async () => {
    const r = rig();
    r.book.accept(r.body());
    r.time.advance(11 * 60_000);
    expect(r.book.state("req-00000001")).toBe("expired");
    await expect(r.book.funded("req-00000001", SIGNATURE)).rejects.toThrow(/expired/);
  });
});

describe("the Solana funding check", () => {
  const bridgeAta = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const balance = (amount: string, index = 1) => ({
    accountIndex: index,
    mint: mint.toBase58(),
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "" },
  });
  const verifierFor = (tx: unknown) =>
    new SolanaFundingVerifier({ getParsedTransaction: async () => tx } as unknown as Connection, mint);
  const parsed = (meta: Record<string, unknown>) => ({
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], ...meta },
    transaction: { message: { accountKeys: [{ pubkey: Keypair.generate().publicKey }, { pubkey: bridgeAta }] } },
  });
  const input = { signature: SIGNATURE, bridgeAta: bridgeAta.toBase58(), amount: AMOUNT };

  it("reads the amount the bridge account received from the token balances", async () => {
    const tx = parsed({ preTokenBalances: [balance("100")], postTokenBalances: [balance("400000100")] });
    expect(await verifierFor(tx).verify(input)).toEqual({ status: "found", received: 400_000_000n });
  });

  it("counts nothing for a failed transaction or one that did not touch the account", async () => {
    expect(await verifierFor(parsed({ err: {}, postTokenBalances: [balance("5")] })).verify(input)).toEqual({ status: "found", received: 0n });
    expect(await verifierFor(parsed({ postTokenBalances: [balance("5", 0)] })).verify(input)).toEqual({ status: "found", received: 0n });
  });

  it("reports a transaction the node does not know as missing", async () => {
    expect(await verifierFor(null).verify(input)).toEqual({ status: "missing" });
  });
});

describe("a transfer in (hypercore-solana)", () => {
  it("withdraws from HyperCore toward the maker token account on Solana and mints there", async () => {
    const r = rig();
    const base = await serve(r);
    expect((await post(base, "/v1/rebalance/requests", r.body({ direction: "in" }))).status).toBe(202);
    r.debitAndBurn();
    await r.run();
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.action).toMatchObject({
      type: "sendToEvmWithData",
      destinationRecipient: r.makerAta.toBase58(),
      addressEncoding: "base58",
      destinationChainId: CCTP_DOMAINS.solana,
    });
    expect(r.received).toEqual([r.makerOwner]);
    expect(r.book.state("req-00000001")).toBe("wallet-credited");
    expect(r.store.forIntent("req-00000001")[0]?.route).toBe("hypercore-solana");
  });

  it("ends expired when it could not start before it was valid", async () => {
    const r = rig();
    r.book.accept(r.body({ requestId: "req-out-00001" }));
    await r.book.funded("req-out-00001", SIGNATURE);
    await r.run(2);
    r.book.accept(r.body({ requestId: "req-in-000001", direction: "in", seq: 2 }));
    r.time.advance(11 * 60_000);
    await r.run(2);
    expect(r.book.state("req-in-000001")).toBe("expired");
    expect(r.posts).toHaveLength(0);
  });
});

describe("one HyperCore transfer at a time", () => {
  it("holds a second transfer until the first has credited", async () => {
    const r = rig();
    r.book.accept(r.body({ requestId: "req-out-00001" }));
    await r.book.funded("req-out-00001", SIGNATURE);
    r.book.accept(r.body({ requestId: "req-in-000001", direction: "in", seq: 2 }));
    r.debitAndBurn();
    await r.run();
    expect(r.solanaBurns).toHaveLength(1);
    expect(r.posts).toHaveLength(0);
    expect(r.executor.pending().some((entry) => /previous HyperCore transfer/.test(entry.reason))).toBe(true);

    r.credit();
    await r.run();
    expect(r.book.state("req-out-00001")).toBe("credited");
    expect(r.posts).toHaveLength(1);
    expect(r.book.state("req-in-000001")).toBe("wallet-credited");
  });

  it("lets an urgent margin top-up go before a request that arrived earlier", async () => {
    const r = rig();
    r.book.accept(r.body({ direction: "in" }));
    r.executor.submit({
      intentId: word(77),
      closeId: 1,
      route: "arc-hypercore",
      amount: AMOUNT.toString(),
      reason: "margin-urgent",
      marginRatioBps: 400,
    });
    r.debitAndBurn();
    await r.run();
    expect(r.arcBurns).toEqual([`${word(77)}:0`]);
    expect(r.posts).toHaveLength(0);
  });
});
