import { CCTP_DOMAINS, EVM_FUNDING_SOURCES } from "@noirwire/shared";
import { z } from "zod";
import { callBridge, fail, readJson, type Reply } from "./deposit";
import { describeError } from "./request";

const IRIS_TIMEOUT_MS = 10_000;
const DEFAULT_IRIS = "https://iris-api-sandbox.circle.com";
const SOURCE_DOMAINS: number[] = Object.values(EVM_FUNDING_SOURCES).map((source) => source.cctpDomain);

const domainParam = z.coerce.number().int().refine((value) => SOURCE_DOMAINS.includes(value), "Unknown source network.");
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const feeTiers = z.array(z.object({ finalityThreshold: z.number(), minimumFee: z.number() }));
const irisMessages = z.object({
  messages: z.array(z.object({ message: z.string(), attestation: z.string().nullable().optional(), status: z.string().optional() })),
});
const submittedBody = z.object({ domain: domainParam, txHash });

function irisBase(): string {
  return (process.env.IRIS_API_URL?.trim() || DEFAULT_IRIS).replace(/\/+$/, "");
}

async function iris(path: string): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const response = await fetch(`${irisBase()}${path}`, { cache: "no-store", signal: AbortSignal.timeout(IRIS_TIMEOUT_MS) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

export async function evmStatus(): Promise<Reply> {
  const reply = await callBridge("GET", "/v1/deposits/evm/status");
  if (reply.status === 200) return reply;
  const reason =
    reply.status === 404
      ? "The bridge does not relay deposits from Ethereum networks yet, so a burn started here could not be delivered. Nothing is sent until it does."
      : String((reply.body as { error?: string }).error ?? "The bridge is not connected.");
  return { status: 200, body: { available: false, reason } };
}

export async function evmFee(searchParams: URLSearchParams): Promise<Reply> {
  const domain = domainParam.safeParse(searchParams.get("domain"));
  if (!domain.success) return fail(400, "Unknown source network.");
  const result = await iris(`/v2/burn/USDC/fees/${domain.data}/${CCTP_DOMAINS.arc}`);
  if ("error" in result) return fail(502, `Circle's fee service is not reachable (${result.error}).`);
  const tiers = feeTiers.safeParse(result.body);
  if (result.status !== 200 || !tiers.success) return fail(502, "Circle's fee service did not answer with a fee.");
  return { status: 200, body: { tiers: tiers.data } };
}

export async function evmAttestation(searchParams: URLSearchParams): Promise<Reply> {
  const domain = domainParam.safeParse(searchParams.get("domain"));
  const hash = txHash.safeParse(searchParams.get("tx"));
  if (!domain.success || !hash.success) return fail(400, "A source network and transaction hash are required.");
  const result = await iris(`/v2/messages/${domain.data}?transactionHash=${hash.data}`);
  if ("error" in result) return fail(502, `Circle's attestation service is not reachable (${result.error}).`);
  if (result.status === 404) return { status: 200, body: { state: "pending" } };
  const parsed = irisMessages.safeParse(result.body);
  if (result.status !== 200 || !parsed.success) return fail(502, "Circle's attestation service gave an unreadable answer.");
  const entry = parsed.data.messages[0];
  const attestation = entry?.attestation;
  if (!entry || entry.status !== "complete" || !attestation || !/^0x[0-9a-fA-F]+$/.test(attestation) || entry.message === "0x") {
    return { status: 200, body: { state: "pending" } };
  }
  return { status: 200, body: { state: "complete", message: entry.message, attestation } };
}

export async function evmSubmitted(request: Request): Promise<Reply> {
  const parsed = submittedBody.safeParse(await readJson(request));
  if (!parsed.success) return fail(400, "A source network and transaction hash are required.");
  const reply = await callBridge("POST", "/v1/deposits/evm/submitted", parsed.data);
  if (reply.status === 404 && (reply.body as { error?: string }).error === "not found") {
    return fail(409, "The bridge does not relay deposits from Ethereum networks yet.");
  }
  return reply;
}
