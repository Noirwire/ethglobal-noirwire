import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { flowEvent, topUpIntent, type BridgeTransfer, type FlowEvent } from "@noirwire/shared";
import { z } from "zod";
import { IntentRejected, type TreasuryExecutor } from "./executor.ts";
import type { TransferStore } from "./transfers.ts";

export const DEFAULT_BRIDGE_PORT = 8702;

export type DevDeposit = (amount: bigint | undefined) => { transfers: BridgeTransfer[]; beneficiary: string };

const devDepositBody = z.object({ amount: z.string().regex(/^[1-9]\d*$/).optional() });

const ALLOW_ORIGIN = { "access-control-allow-origin": "*" };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...ALLOW_ORIGIN });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

export function transferEvent(transfer: BridgeTransfer): FlowEvent {
  return { kind: "transfer", at: transfer.updatedAt, transfer };
}

export function createBridgeServer(store: TransferStore, executor: TreasuryExecutor, devDeposit?: DevDeposit): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...ALLOW_ORIGIN, "access-control-allow-headers": "content-type" });
        return res.end();
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
        const parsed = topUpIntent.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: parsed.error.message });
        const transfers = executor.submit(parsed.data);
        void executor.tick();
        return json(res, 202, { transfers });
      }
      if (req.method === "POST" && url.pathname === "/v1/dev/deposit" && devDeposit) {
        const parsed = devDepositBody.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: parsed.error.message });
        const result = devDeposit(parsed.data.amount === undefined ? undefined : BigInt(parsed.data.amount));
        return json(res, 202, result);
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
      if (error instanceof IntentRejected) return json(res, 422, { error: error.message });
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
