import { z } from "zod";
import { loadEnv } from "../env";
import { describeError } from "./request";
import { inspectPreparedDeposit } from "./prepared";

const BRIDGE_TIMEOUT_MS = 15_000;

type Reply = { status: number; body: unknown };

const prepareBody = z.object({
  owner: z.string().min(32).max(44),
  amount: z.string().regex(/^[1-9]\d*$/),
  beneficiary: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const submittedBody = z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) });
const devBody = z.object({ amount: z.string().regex(/^[1-9]\d*$/).optional() });

export const json = (reply: Reply): Response => Response.json(reply.body, { status: reply.status, headers: { "cache-control": "no-store" } });

const fail = (status: number, error: string): Reply => ({ status, body: { error } });

async function callBridge(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  const { bridgeUrl } = loadEnv();
  try {
    const response = await fetch(`${bridgeUrl}${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const parsed: unknown = await response.json().catch(() => ({ error: `Bridge answered HTTP ${response.status}` }));
    return { status: response.status, body: parsed };
  } catch (error) {
    return fail(502, `The bridge is not connected (${describeError(error)}). Try again when it is back.`);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function solanaStatus(): Promise<Reply> {
  return callBridge("GET", "/v1/deposits/solana/status");
}

export async function solanaPrepare(request: Request): Promise<Reply> {
  const parsed = prepareBody.safeParse(await readJson(request));
  if (!parsed.success) return fail(400, "Owner, amount and beneficiary are required.");
  const reply = await callBridge("POST", "/v1/deposits/solana/prepare", parsed.data);
  if (reply.status !== 200) return reply;
  const transaction = (reply.body as { transaction?: unknown }).transaction;
  if (typeof transaction !== "string") return fail(502, "The bridge answered without a transaction.");
  const problem = inspectPreparedDeposit(transaction, {
    owner: parsed.data.owner,
    amount: BigInt(parsed.data.amount),
    beneficiary: parsed.data.beneficiary,
  });
  if (problem) return fail(502, `The prepared transaction was refused before reaching your wallet: ${problem}.`);
  return reply;
}

export async function solanaSubmitted(request: Request): Promise<Reply> {
  const parsed = submittedBody.safeParse(await readJson(request));
  if (!parsed.success) return fail(400, "A transaction signature is required.");
  return callBridge("POST", "/v1/deposits/solana/submitted", parsed.data);
}

export async function localSimulation(request: Request): Promise<Reply> {
  const parsed = devBody.safeParse(await readJson(request));
  if (!parsed.success) return fail(400, "The amount must be a whole number of base units.");
  const reply = await callBridge("POST", "/v1/dev/deposit", parsed.data);
  if (reply.status === 404) return fail(409, "The bridge is not running on a local chain, so there is nothing to simulate.");
  return reply;
}
