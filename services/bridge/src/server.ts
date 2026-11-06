import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { flowEvent, topUpIntent, type BridgeTransfer, type FlowEvent } from "@noirwire/shared";
import { z } from "zod";
import { IntentForbidden, IntentRejected, type TreasuryExecutor } from "./executor.ts";
import {
  DepositRefused,
  DepositUnavailable,
  TransactionNotFound,
  UnavailableDeposits,
  type SolanaDepositApi,
} from "./solana-deposit.ts";
import { UnavailableEvmDeposits, type EvmDepositApi } from "./evm-deposit.ts";
import {
  fundedBody,
  RequestConflict,
  RequestInvalid,
  RequestUnknown,
  type RebalanceBook,
} from "./rebalance.ts";
import type { TransferStore } from "./transfers.ts";

export const DEFAULT_BRIDGE_PORT = 8702;

export type DevDeposit = (amount: bigint | undefined) => { transfers: BridgeTransfer[]; beneficiary: string };

const devDepositBody = z.object({ amount: z.string().regex(/^[1-9]\d*$/).optional() });

const ALLOW_ORIGIN = { "access-control-allow-origin": "*" };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...ALLOW_ORIGIN });
  res.end(JSON.stringify(body));
}

class BadRequest extends Error {}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const text = await readText(req);
  const parsed = schema.safeParse(text.trim() ? JSON.parse(text) : {});
  if (!parsed.success) throw new BadRequest(parsed.error.message);
  return parsed.data;
}

const prepareBody = z.object({
  owner: z.string().min(32).max(44),
  amount: z.string().regex(/^[1-9]\d*$/),
  beneficiary: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const submittedBody = z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) });

const evmSubmittedBody = z.object({
  domain: z.number().int().nonnegative(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const NO_EVM_DEPOSITS = new UnavailableEvmDeposits("Deposits from Ethereum networks are not configured on this bridge");
const NO_SOLANA_DEPOSITS =new UnavailableDeposits("testnet", "Solana deposits are not configured on this bridge");

export function transferEvent(transfer: BridgeTransfer): FlowEvent {
  return { kind: "transfer", at: transfer.updatedAt, transfer };
}

function knownError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof BadRequest) json(res, 400, { error: error.message });
  else if (error instanceof IntentForbidden) json(res, 403, { error: error.message });
  else if (error instanceof DepositUnavailable || error instanceof RequestConflict) json(res, 409, { error: error.message });
  else if (error instanceof RequestUnknown) json(res, 404, { error: error.message });
  else if (error instanceof RequestInvalid) json(res, 422, { error: error.message });
  else if (error instanceof TransactionNotFound) json(res, 404, { error: error.message });
  else if (error instanceof DepositRefused || error instanceof IntentRejected) json(res, 422, { error: error.message });
  else return false;
  return true;
}

const MIN_API_TOKEN_LENGTH = 32;

export function resolveApiToken(
  network: "testnet" | "local",
  value: string | undefined,
  name = "BRIDGE_API_TOKEN",
): string | undefined {
  if (value === undefined) {
    if (network === "testnet") throw new Error(`${name} is required in testnet mode`);
    return undefined;
  }
  if (value.length < MIN_API_TOKEN_LENGTH) throw new Error(`${name} must be at least ${MIN_API_TOKEN_LENGTH} characters`);
  return value;
}

export type RebalanceApi = { book: RebalanceBook; token?: string };

const REBALANCE_PREFIX = "/v1/rebalance/requests";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readText(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestInvalid("the body is not valid JSON");
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), digest(token));
}

async function handleRebalance(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rebalance: RebalanceApi,
  executor: TreasuryExecutor,
): Promise<void> {
  if (rebalance.token && !authorized(req, rebalance.token)) return json(res, 401, { error: "unauthorized" });
  const tail = url.pathname.slice(REBALANCE_PREFIX.length);
  if (req.method === "POST" && tail === "") {
    const accepted = rebalance.book.accept(await readJson(req));
    void rebalance.book.tick().then(() => executor.tick());
    return json(res, 202, accepted);
  }
  const id = decodeURIComponent(tail.split("/")[1] ?? "");
  if (req.method === "GET" && /^\/[^/]+$/.test(tail)) {
    const state = rebalance.book.state(id);
    return state ? json(res, 200, { state }) : json(res, 404, { error: "unknown request" });
  }
  if (req.method === "POST" && /^\/[^/]+\/funded$/.test(tail)) {
    const body = fundedBody.safeParse(await readJson(req));
    if (!body.success) throw new RequestInvalid(body.error.message);
    const state = await rebalance.book.funded(id, body.data.signature);
    void executor.tick();
    return json(res, 202, { state });
  }
  return json(res, 404, { error: "not found" });
}

function handleTransfers(req: IncomingMessage, res: ServerResponse, url: URL, store: TransferStore, executor: TreasuryExecutor): boolean {
  if (req.method === "GET" && url.pathname === "/v1/transfers") {
    const state = url.searchParams.get("state");
    const transfers = state === "in-flight" ? store.inFlight() : store.list().filter((t) => !state || t.state === state);
    json(res, 200, transfers.map((transfer) => executor.view(transfer)));
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/v1/transfers/")) {
    const transfer = store.get(decodeURIComponent(url.pathname.slice("/v1/transfers/".length)));
    if (transfer) json(res, 200, executor.view(transfer));
    else json(res, 404, { error: "unknown transfer" });
    return true;
  }
  return false;
}

async function handleDeposits(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  solanaDeposits: SolanaDepositApi,
  evmDeposits: EvmDepositApi,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/deposits/evm/status") {
    json(res, 200, evmDeposits.status());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/deposits/evm/submitted") {
    const { domain, txHash } = await readBody(req, evmSubmittedBody);
    json(res, 202, { transfer: await evmDeposits.register(domain, txHash) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/v1/deposits/solana/status") {
    json(res, 200, solanaDeposits.status());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/deposits/solana/prepare") {
    const body = await readBody(req, prepareBody);
    json(res, 200, await solanaDeposits.prepare({ ...body, amount: BigInt(body.amount) }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/deposits/solana/submitted") {
    const { signature } = await readBody(req, submittedBody);
    json(res, 202, { transfer: await solanaDeposits.register(signature) });
    return true;
  }
  return false;
}

function streamEvents(req: IncomingMessage, res: ServerResponse, store: TransferStore): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...ALLOW_ORIGIN,
  });
  res.write(": connected\n\n");
  const off = store.onChange((transfer) => res.write(`data: ${JSON.stringify(transferEvent(transfer))}\n\n`));
  req.on("close", off);
}

export function createBridgeServer(
  store: TransferStore,
  executor: TreasuryExecutor,
  devDeposit?: DevDeposit,
  solanaDeposits: SolanaDepositApi = NO_SOLANA_DEPOSITS,
  apiToken?: string,
  rebalance?: RebalanceApi,
  evmDeposits: EvmDepositApi = NO_EVM_DEPOSITS,
): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...ALLOW_ORIGIN, "access-control-allow-headers": "content-type" });
        return res.end();
      }
      if (rebalance && url.pathname.startsWith(REBALANCE_PREFIX)) {
        return await handleRebalance(req, res, url, rebalance, executor);
      }
      if (req.method === "POST" && apiToken && !authorized(req, apiToken)) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (handleTransfers(req, res, url, store, executor)) return;
      if (req.method === "POST" && url.pathname === "/v1/intents") {
        const transfers = executor.submitExternal(await readBody(req, topUpIntent));
        void executor.tick();
        return json(res, 202, { transfers });
      }
      if (req.method === "POST" && url.pathname === "/v1/dev/deposit" && devDeposit) {
        const { amount } = await readBody(req, devDepositBody);
        return json(res, 202, devDeposit(amount === undefined ? undefined : BigInt(amount)));
      }
      if (await handleDeposits(req, res, url, solanaDeposits, evmDeposits)) return;
      if (req.method === "GET" && url.pathname === "/events") return streamEvents(req, res, store);
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (knownError(res, error)) return;
      return json(res, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  });
}

export class IntentFileWatcher {
  private offset = 0;

  constructor(
    private readonly path: string,
    private readonly executor: TreasuryExecutor,
  ) {}

  poll(): number {
    if (!existsSync(this.path)) return 0;
    const text = readFileSync(this.path, "utf8");
    if (text.length < this.offset) this.offset = 0;
    const fresh = text.slice(this.offset);
    const lastNewline = fresh.lastIndexOf("\n");
    if (lastNewline < 0) return 0;
    this.offset += lastNewline + 1;
    let accepted = 0;
    for (const line of fresh.slice(0, lastNewline).split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = flowEvent.parse(JSON.parse(line));
        if (event.kind === "intent") {
          this.executor.submitExternal(event.intent);
          accepted++;
        }
      } catch (error) {
        console.error("intent line skipped:", error instanceof Error ? error.message : error);
      }
    }
    return accepted;
  }
}
