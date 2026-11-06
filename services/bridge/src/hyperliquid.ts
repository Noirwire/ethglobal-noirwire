import { toBaseUnits, USDC_DECIMALS } from "@noirwire/shared";
import { z } from "zod";

export interface HyperCoreReader {
  balance(address: string): Promise<bigint>;
}

export type LedgerEntry = {
  time: number;
  hash?: string;
  type: string;
  amount?: bigint;
  token?: string;
  user?: string;
  destination?: string;
};

export interface HyperCoreLedger {
  entries(user: string, startTime: number): Promise<LedgerEntry[]>;
}

export type LedgerMatchConfig = {
  debitTypes: readonly string[];
  creditTypes: readonly string[];
  creditCounterparty: string;
  amountTolerance: bigint;
};

export const DEFAULT_LEDGER_MATCH = {
  debitTypes: ["sendToEvmWithData", "send", "spotTransfer", "withdraw", "internalTransfer"],
  creditTypes: ["spotTransfer"],
  amountTolerance: 1_000_000n,
} as const;

const ledgerResponse = z.array(
  z.object({
    time: z.number(),
    hash: z.string().optional(),
    delta: z.looseObject({ type: z.string() }),
  }),
);

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function amountOf(delta: Record<string, unknown>): bigint | undefined {
  const raw = text(delta.usdc) ?? text(delta.amount);
  if (raw === undefined) return undefined;
  try {
    return toBaseUnits(raw, USDC_DECIMALS);
  } catch {
    return undefined;
  }
}

export class HyperliquidLedgerReader implements HyperCoreLedger {
  constructor(
    private readonly infoUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async entries(user: string, startTime: number): Promise<LedgerEntry[]> {
    const response = await this.fetchImpl(this.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "userNonFundingLedgerUpdates", user, startTime }),
    });
    if (!response.ok) throw new Error(`Hyperliquid info ${response.status}`);
    return ledgerResponse.parse(await response.json()).map(({ time, hash, delta }) => ({
      time,
      hash,
      type: delta.type,
      amount: amountOf(delta),
      token: text(delta.token),
      user: text(delta.user),
      destination: text(delta.destination),
    }));
  }
}

const within = (actual: bigint | undefined, expected: bigint, tolerance: bigint): boolean =>
  actual !== undefined && (actual > expected ? actual - expected : expected - actual) <= tolerance;

const sameAddress = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

export function matchesDebit(entry: LedgerEntry, config: LedgerMatchConfig, amount: bigint, since: number): boolean {
  return entry.time >= since && config.debitTypes.includes(entry.type) && within(entry.amount, amount, config.amountTolerance);
}

export function matchesCredit(entry: LedgerEntry, config: LedgerMatchConfig, recipient: string, amount: bigint, since: number): boolean {
  return (
    entry.time >= since &&
    config.creditTypes.includes(entry.type) &&
    (entry.token === undefined || entry.token.toUpperCase().startsWith("USDC")) &&
    sameAddress(entry.user, config.creditCounterparty) &&
    sameAddress(entry.destination, recipient) &&
    within(entry.amount, amount, config.amountTolerance)
  );
}

const perpsState =z.object({ marginSummary: z.object({ accountValue: z.string() }) });
const spotState = z.object({ balances: z.array(z.object({ coin: z.string(), total: z.string() })) });

export class HyperliquidInfoReader implements HyperCoreReader {
  constructor(
    private readonly infoUrl: string,
    private readonly dex: "perps" | "spot" = "perps",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async balance(address: string): Promise<bigint> {
    const type = this.dex === "perps" ? "clearinghouseState" : "spotClearinghouseState";
    const response = await this.fetchImpl(this.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, user: address }),
    });
    if (!response.ok) throw new Error(`Hyperliquid info ${response.status}`);
    const json: unknown = await response.json();
    if (this.dex === "perps") {
      return toBaseUnits(perpsState.parse(json).marginSummary.accountValue, USDC_DECIMALS);
    }
    const usdc = spotState.parse(json).balances.find((entry) => entry.coin === "USDC");
    return usdc ? toBaseUnits(usdc.total, USDC_DECIMALS) : 0n;
  }
}
