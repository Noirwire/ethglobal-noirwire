import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { TopUpIntent, TransferRoute } from "@noirwire/shared";
import { z } from "zod";
import { REQUEST_EXPIRED_REASON, type TreasuryExecutor } from "./executor.ts";
import type { TransferStore } from "./transfers.ts";

export const REBALANCE_ROUTES = { out: "solana-hypercore", in: "hypercore-solana" } as const satisfies Record<string, TransferRoute>;

const FUNDING_WAIT_MS = 10 * 60_000;

export const requestBody = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  direction: z.enum(["out", "in"]),
  amount: z.string().regex(/^[1-9]\d*$/),
  requestedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  seq: z.number().int().min(1),
});
export type RebalanceRequest = z.infer<typeof requestBody>;

export const fundedBody = z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) });

export class RequestInvalid extends Error {}
export class RequestConflict extends Error {}
export class RequestUnknown extends Error {}

export type FundingCheck = { status: "missing" } | { status: "found"; received: bigint };

export interface FundingVerifier {
  verify(input: { signature: string; bridgeAta: string; amount: bigint }): Promise<FundingCheck>;
}

export class SolanaFundingVerifier implements FundingVerifier {
  constructor(
    private readonly connection: Pick<Connection, "getParsedTransaction">,
    private readonly usdcMint: PublicKey,
  ) {}

  async verify({ signature, bridgeAta }: { signature: string; bridgeAta: string }): Promise<FundingCheck> {
    const tx = await this.connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return { status: "missing" };
    if (tx.meta.err) return { status: "found", received: 0n };
    const index = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === bridgeAta);
    if (index < 0) return { status: "found", received: 0n };
    const mint = this.usdcMint.toBase58();
    const total = (balances: typeof tx.meta.postTokenBalances) =>
      (balances ?? [])
        .filter((balance) => balance.accountIndex === index && balance.mint === mint)
        .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
    const received = total(tx.meta.postTokenBalances) - total(tx.meta.preTokenBalances);
    return { status: "found", received: received > 0n ? received : 0n };
  }
}

export class AcceptingFundingVerifier implements FundingVerifier {
  async verify({ amount }: { amount: bigint }): Promise<FundingCheck> {
    return { status: "found", received: amount };
  }
}

type Stored = {
  request: RebalanceRequest;
  receivedAt: string;
  funded?: { signature: string; at: string };
  started?: boolean;
  failure?: string;
};

export type RebalanceState =
  | "awaiting-funds"
  | "verifying-funds"
  | "in-progress"
  | "credited"
  | "wallet-credited"
  | "failed"
  | "expired";

export type RebalanceOptions = {
  bridgeAta: string;
  verifier: FundingVerifier;
  journalPath?: string;
  now?: () => Date;
};

const sameRequest = (a: RebalanceRequest, b: RebalanceRequest): boolean =>
  a.direction === b.direction &&
  a.amount === b.amount &&
  a.requestedAt === b.requestedAt &&
  a.validUntil === b.validUntil &&
  a.seq === b.seq;

export class RebalanceBook {
  private readonly records = new Map<string, Stored>();
  private readonly verifying = new Set<string>();
  private readonly now: () => Date;

  constructor(
    private readonly executor: TreasuryExecutor,
    private readonly store: TransferStore,
    private readonly options: RebalanceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    if (options.journalPath && existsSync(options.journalPath)) {
      for (const line of readFileSync(options.journalPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const stored = JSON.parse(line) as Stored;
          this.records.set(stored.request.requestId, stored);
        } catch {
          continue;
        }
      }
    }
  }

  get bridgeAta(): string {
    return this.options.bridgeAta;
  }

  accept(input: unknown): { bridgeAta: string } {
    const parsed = requestBody.safeParse(input);
    if (!parsed.success) throw new RequestInvalid(parsed.error.message);
    const request = parsed.data;
    const existing = this.records.get(request.requestId);
    if (existing) {
      if (!sameRequest(existing.request, request)) throw new RequestConflict(`request ${request.requestId} was already used with different terms`);
      return { bridgeAta: this.options.bridgeAta };
    }
    if (Date.parse(request.validUntil) <= Date.parse(request.requestedAt)) throw new RequestInvalid("validUntil must be after requestedAt");
    if (Date.parse(request.validUntil) <= this.now().getTime()) throw new RequestInvalid("the request has already expired");
    this.executor.checkDeposit(REBALANCE_ROUTES[request.direction], BigInt(request.amount));
    const stored: Stored = { request, receivedAt: this.now().toISOString() };
    this.records.set(request.requestId, stored);
    if (request.direction === "in") this.start(stored);
    else this.persist(stored);
    return { bridgeAta: this.options.bridgeAta };
  }

  async funded(requestId: string, signature: string): Promise<RebalanceState> {
    const stored = this.records.get(requestId);
    if (!stored) throw new RequestUnknown(`unknown request ${requestId}`);
    if (stored.request.direction !== "out") throw new RequestConflict("only a transfer out is funded by the maker");
    if (stored.funded) {
      if (stored.funded.signature !== signature) throw new RequestConflict("the request was already funded by another transaction");
    } else {
      if (stored.failure !== undefined) throw new RequestConflict(`the request is ${this.stateOf(stored)}`);
      if (this.now().getTime() > Date.parse(stored.request.validUntil)) throw new RequestConflict("the request has expired");
      for (const other of this.records.values()) {
        if (other.funded?.signature === signature) throw new RequestConflict("that transaction already funded another request");
      }
      stored.funded = { signature, at: this.now().toISOString() };
      this.persist(stored);
    }
    await this.processOut(stored);
    return this.stateOf(stored);
  }

  state(requestId: string): RebalanceState | undefined {
    const stored = this.records.get(requestId);
    return stored ? this.stateOf(stored) : undefined;
  }

  async tick(): Promise<void> {
    for (const stored of this.records.values()) {
      if (stored.started || stored.failure !== undefined) continue;
      if (stored.request.direction === "in") this.start(stored);
      else await this.processOut(stored);
    }
  }

  private async processOut(stored: Stored): Promise<void> {
    const id = stored.request.requestId;
    if (!stored.funded || stored.started || stored.failure !== undefined || this.verifying.has(id)) return;
    this.verifying.add(id);
    try {
      let check: FundingCheck = { status: "missing" };
      try {
        check = await this.options.verifier.verify({
          signature: stored.funded.signature,
          bridgeAta: this.options.bridgeAta,
          amount: BigInt(stored.request.amount),
        });
      } catch {
        check = { status: "missing" };
      }
      if (check.status === "missing") {
        if (this.now().getTime() - Date.parse(stored.funded.at) > FUNDING_WAIT_MS) this.fail(stored, "the funding transaction was not found on chain");
        return;
      }
      const amount = BigInt(stored.request.amount);
      if (check.received < amount) {
        this.fail(stored, `the funding transaction moved ${check.received} base units to the bridge account, less than the ${amount} requested`);
        return;
      }
      this.start(stored);
    } finally {
      this.verifying.delete(id);
    }
  }

  private start(stored: Stored): void {
    const { request } = stored;
    const intent: TopUpIntent = {
      intentId: request.requestId,
      closeId: request.seq,
      route: REBALANCE_ROUTES[request.direction],
      amount: request.amount,
      reason: "solana-rebalance",
      marginRatioBps: 0,
    };
    try {
      this.executor.submit(intent, request.direction === "in" ? { validUntil: request.validUntil } : {});
      stored.started = true;
      this.persist(stored);
    } catch (error) {
      this.fail(stored, error instanceof Error ? error.message : String(error));
    }
  }

  private fail(stored: Stored, reason: string): void {
    stored.failure = reason;
    this.persist(stored);
  }

  private persist(stored: Stored): void {
    const path = this.options.journalPath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(stored)}\n`);
  }

  private stateOf(stored: Stored): RebalanceState {
    if (stored.failure !== undefined) return stored.failure === REQUEST_EXPIRED_REASON ? "expired" : "failed";
    if (!stored.started) {
      if (stored.funded) return "verifying-funds";
      return this.now().getTime() > Date.parse(stored.request.validUntil) ? "expired" : "awaiting-funds";
    }
    const transfers = this.store.forIntent(stored.request.requestId);
    const failed = transfers.find((transfer) => transfer.state === "failed");
    if (failed) return failed.error === REQUEST_EXPIRED_REASON ? "expired" : "failed";
    if (transfers.length > 0 && transfers.every((transfer) => transfer.state === "credited")) {
      return stored.request.direction === "in" ? "wallet-credited" : "credited";
    }
    return "in-progress";
  }
}
