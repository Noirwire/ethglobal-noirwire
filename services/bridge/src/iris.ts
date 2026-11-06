import { concatHex, isHex, keccak256, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { z } from "zod";

export const IRIS_SANDBOX_URL = "https://iris-api-sandbox.circle.com";

export type AttesterLabel = "circle-iris" | "local-test-attester";

export type AttestationQuery = {
  sourceDomain: number;
  txHash: string;
  message?: Hex;
};

export type Attestation = {
  status: "pending" | "complete";
  message?: Hex;
  attestation?: Hex;
  eventNonce?: string;
  decoded?: {
    sourceDomain: number;
    destinationDomain: number;
    nonce: string;
    amount?: string;
    mintRecipient?: string;
    hookData?: string;
  };
  forward?: { state: "PENDING" | "COMPLETE" | "FAILED"; txHash?: string; mintTxHash?: string };
  delayReason?: string;
};

export interface Attester {
  readonly label: AttesterLabel;
  fetchAttestation(query: AttestationQuery): Promise<Attestation>;
}

const irisMessage = z.object({
  message: z.string(),
  eventNonce: z.string().optional(),
  attestation: z.string().nullable().optional(),
  status: z.string(),
  delayReason: z.string().nullable().optional(),
  forwardState: z.string().optional(),
  forwardTxHash: z.string().optional(),
  destinationMintTxHash: z.string().optional(),
  decodedMessage: z
    .object({
      sourceDomain: z.string(),
      destinationDomain: z.string(),
      nonce: z.string(),
      decodedMessageBody: z
        .object({
          amount: z.string().optional(),
          mintRecipient: z.string().optional(),
          hookData: z.string().optional(),
        })
        .nullish(),
    })
    .nullish(),
});

const irisResponse = z.object({ messages: z.array(irisMessage) });

export function parseIrisResponse(body: unknown): Attestation {
  const parsed = irisResponse.parse(body);
  const entry = parsed.messages[0];
  if (!entry) return { status: "pending" };
  const attestation = entry.status === "complete" && entry.attestation && isHex(entry.attestation) ? entry.attestation : undefined;
  const forwardState = entry.forwardState?.toUpperCase();
  const decoded = entry.decodedMessage;
  return {
    status: attestation ? "complete" : "pending",
    message: isHex(entry.message) && entry.message !== "0x" ? entry.message : undefined,
    attestation,
    eventNonce: entry.eventNonce,
    decoded: decoded
      ? {
          sourceDomain: Number(decoded.sourceDomain),
          destinationDomain: Number(decoded.destinationDomain),
          nonce: decoded.nonce,
          amount: decoded.decodedMessageBody?.amount,
          mintRecipient: decoded.decodedMessageBody?.mintRecipient,
          hookData: decoded.decodedMessageBody?.hookData,
        }
      : undefined,
    forward: forwardState
      ? {
          state: forwardState === "COMPLETE" || forwardState === "FAILED" ? forwardState : "PENDING",
          txHash: entry.forwardTxHash,
          mintTxHash: entry.destinationMintTxHash,
        }
      : undefined,
    delayReason: entry.delayReason ?? undefined,
  };
}

export class IrisClient implements Attester {
  readonly label = "circle-iris" as const;

  constructor(
    private readonly baseUrl: string = IRIS_SANDBOX_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchAttestation(query: AttestationQuery): Promise<Attestation> {
    const url = `${this.baseUrl}/v2/messages/${query.sourceDomain}?transactionHash=${encodeURIComponent(query.txHash)}`;
    const response = await this.fetchImpl(url);
    if (response.status === 404) return { status: "pending" };
    if (!response.ok) throw new Error(`Iris ${response.status} for ${url}`);
    return parseIrisResponse(await response.json());
  }

}

export class LocalAttester implements Attester {
  readonly label = "local-test-attester" as const;
  private readonly keys: Hex[];

  constructor(privateKeys: Hex[]) {
    if (privateKeys.length === 0) throw new Error("LocalAttester needs at least one key");
    this.keys = [...privateKeys].sort((a, b) =>
      BigInt(privateKeyToAccount(a).address) < BigInt(privateKeyToAccount(b).address) ? -1 : 1,
    );
  }

  signers(): Hex[] {
    return this.keys.map((key) => privateKeyToAccount(key).address);
  }

  async attest(message: Hex): Promise<Hex> {
    const digest = keccak256(message);
    const signatures = await Promise.all(this.keys.map((key) => sign({ hash: digest, privateKey: key, to: "hex" })));
    return concatHex(signatures);
  }

  async fetchAttestation(query: AttestationQuery): Promise<Attestation> {
    if (!query.message) return { status: "pending" };
    return { status: "complete", message: query.message, attestation: await this.attest(query.message) };
  }
}

export class AttestationTimeout extends Error {}

export type PollOptions = {
  intervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function pollAttestation(
  attester: Attester,
  query: AttestationQuery,
  options: PollOptions = {},
): Promise<Attestation> {
  const { intervalMs = 2000, maxIntervalMs = 30_000, timeoutMs = 20 * 60_000 } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let wait = intervalMs;
  for (;;) {
    let result: Attestation | undefined;
    try {
      result = await attester.fetchAttestation(query);
    } catch {
      result = undefined;
    }
    if (result?.status === "complete") return result;
    if (now() + wait > deadline) throw new AttestationTimeout(`no attestation for ${query.txHash} within ${timeoutMs}ms`);
    await sleep(wait);
    wait = Math.min(wait * 2, maxIntervalMs);
  }
}
