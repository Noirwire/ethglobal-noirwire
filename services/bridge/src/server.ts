import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { flowEvent, topUpIntent, type BridgeTransfer, type FlowEvent } from "@noirwire/shared";
import { z } from "zod";
import { IntentRejected, type TreasuryExecutor } from "./executor.ts";
import {
  DepositRefused,
  DepositUnavailable,
  TransactionNotFound,
  UnavailableDeposits,
  type SolanaDepositApi,
} from "./solana-deposit.ts";
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

async function readBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
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

const NO_SOLANA_DEPOSITS = new UnavailableDeposits("testnet", "Solana deposits are not configured on this bridge");

export function transferEvent(transfer: BridgeTransfer): FlowEvent {
  return { kind: "transfer", at: transfer.updatedAt, transfer };
}

function knownError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof BadRequest) json(res, 400, { error: error.message });
  else if (error instanceof DepositUnavailable) json(res, 409, { error: error.message });
  else if (error instanceof TransactionNotFound) json(res, 404, { error: error.message });
  else if (error instanceof DepositRefused || error instanceof IntentRejected) json(res, 422, { error: error.message });
  else return false;
  return true;
}

const MIN_API_TOKEN_LENGTH = 32;

export function resolveApiToken(network: "testnet" | "local", value: string | undefined): string | undefined {
  if (value === undefined) {
    if (network === "testnet") throw new Error("BRIDGE_API_TOKEN is required in testnet mode");
    return undefined;
  }
  if (value.length < MIN_API_TOKEN_LENGTH) throw new Error(`BRIDGE_API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters`);
  return value;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), digest(token));
}

export function createBridgeServer(
  store: TransferStore,
  executor: TreasuryExecutor,
  devDeposit?: DevDeposit,
  solanaDeposits: SolanaDepositApi = NO_SOLANA_DEPOSITS,
  apiToken?: string,
): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...ALLOW_ORIGIN, "access-control-allow-headers": "content-type" });
        return res.end();
      }
      if (req.method === "POST" && apiToken && !authorized(req, apiToken)) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET" && url.pathname === "/v1/transfers") {
        const state = url.searchParams.get("state");
        const transfers = state === "in-flight" ? store.inFlight() : store.list().filter((t) => !state || t.state === state);
        return json(res, 200, transfers);
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/transfers/")) {
        const transfer = store.get(decodeURIComponent(url.pathname.slice("/v1/transfers/".length)));
        return transfer ? json(res, 200, transfer) : json(res, 404, { error: "unknown transfer" });
      }
      if (req.method === "POST" && url.pathname === "/v1/intents") {
        const transfers = executor.submit(await readBody(req, topUpIntent));
        void executor.tick();
        return json(res, 202, { transfers });
      }
      if (req.method === "POST" && url.pathname === "/v1/dev/deposit" && devDeposit) {
        const { amount } = await readBody(req, devDepositBody);
        return json(res, 202, devDeposit(amount === undefined ? undefined : BigInt(amount)));
      }
      if (req.method === "GET" && url.pathname === "/v1/deposits/solana/status") {
        return json(res, 200, solanaDeposits.status());
      }
      if (req.method === "POST" && url.pathname === "/v1/deposits/solana/prepare") {
        const body = await readBody(req, prepareBody);
        return json(res, 200, await solanaDeposits.prepare({ ...body, amount: BigInt(body.amount) }));
      }
      if (req.method === "POST" && url.pathname === "/v1/deposits/solana/submitted") {
        const { signature } = await readBody(req, submittedBody);
        return json(res, 202, { transfer: await solanaDeposits.register(signature) });
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...ALLOW_ORIGIN,
        });
        res.write(": connected\n\n");
        const off = store.onChange((transfer) => res.write(`data: ${JSON.stringify(transferEvent(transfer))}\n\n`));
        req.on("close", off);
        return;
      }
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
          this.executor.submit(event.intent);
          accepted++;
        }
      } catch (error) {
        console.error("intent line skipped:", error instanceof Error ? error.message : error);
      }
    }
    return accepted;
  }
}
