import { USDC_DECIMALS } from "@noirwire/shared";
import { z } from "zod";

export class ConfigError extends Error {}

const enabledFlag = z.enum(["0", "1"], { error: 'HEDGE_ENABLED must be exactly "0" or "1"' });
const intString = z.string().regex(/^\d+$/, "non-negative integer string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const envSchema = z.object({
  HEDGER_MODE: z.enum(["mock", "testnet"]).default("mock"),
  FILL_SOURCE: z.enum(["replay", "tape"]).default("replay"),
  HEDGE_ENABLED: enabledFlag.optional(),
  BOOK_MARKET: z.string().default("NBTC-PERP"),
  HEDGE_COIN: z.string().default("BTC"),
  BOOK_API_URL: z.string().url().optional(),
  HOUSE_MAKER_TAG: z.string().regex(/^\d+$/, "decimal string").optional(),
  REPLAY_FILE: z.string().optional(),
  HL_ACCOUNT_ADDRESS: address.optional(),
  HL_AGENT_PRIVATE_KEY: privateKey.optional(),
  DEADBAND_BTC8: intString.default("20000"),
  MAX_ORDER_BTC8: intString.default("50000000"),
  PRICE_BAND_BPS: z.coerce.number().int().min(1).max(500).default(30),
  SOFT_LIMIT_USD: z.coerce.number().positive().default(2000),
  HARD_LIMIT_USD: z.coerce.number().positive().default(10000),
  REFERENCE_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),
  CONFIRM_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),
  BLIND_AFTER_MS: z.coerce.number().int().positive().default(15_000),
  UNKNOWN_ORDER_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
  TICK_MS: z.coerce.number().int().positive().default(2_000),
  HEDGE_LEVERAGE_TARGET: z.coerce.number().min(3).max(5).default(4),
  INITIAL_MAKER_POSITION_BTC8: z.string().regex(/^-?\d+$/).default("0"),
  JOURNAL_FILE: z.string().default("data/hedger-journal.ndjson"),
  EVENTS_FILE: z.string().default("data/hedger-events.ndjson"),
  CURSOR_FILE: z.string().default("data/tape-cursor.json"),
  KEEP_ALIVE: z.enum(["0", "1"]).default("0"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8701),
});

export type HedgerConfig = {
  mode: "mock" | "testnet";
  fillSource: "replay" | "tape";
  hedgeEnabled: boolean;
  bookMarket: string;
  hedgeCoin: string;
  bookApiUrl: string | undefined;
  houseMakerTag: string | undefined;
  replayFile: string | undefined;
  accountAddress: `0x${string}` | undefined;
  agentPrivateKey: `0x${string}` | undefined;
  deadband8: bigint;
  maxOrder8: bigint;
  priceBandBps: number;
  softLimitUsd6: bigint;
  hardLimitUsd6: bigint;
  referenceMaxAgeMs: number;
  confirmMaxAgeMs: number;
  blindAfterMs: number;
  unknownOrderGraceMs: number;
  tickMs: number;
  leverageTarget: number;
  initialMakerPosition8: bigint;
  journalFile: string;
  eventsFile: string;
  cursorFile: string;
  httpPort: number;
  keepAlive: boolean;
};

function usdToUsd6(value: number): bigint {
  return BigInt(Math.round(value * 10 ** USDC_DECIMALS));
}

export function parseConfig(env: Record<string, string | undefined>): HedgerConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => value !== undefined && (value !== "" || key === "HEDGE_ENABLED")),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigError(`invalid hedger configuration: ${detail}`);
  }
  const raw = parsed.data;
  const hedgeEnabled = resolveHedgeEnabled(raw.HEDGE_ENABLED, raw.HEDGER_MODE);

  if (hedgeEnabled && raw.HEDGER_MODE === "testnet" && !(raw.HL_ACCOUNT_ADDRESS && raw.HL_AGENT_PRIVATE_KEY)) {
    throw new ConfigError(
      "HEDGE_ENABLED=1 but no Hyperliquid venue is configured: set HL_ACCOUNT_ADDRESS and HL_AGENT_PRIVATE_KEY, or set HEDGE_ENABLED=0",
    );
  }
  if (raw.FILL_SOURCE === "tape" && !raw.BOOK_API_URL) {
    throw new ConfigError("FILL_SOURCE=tape requires BOOK_API_URL");
  }
  const soft = usdToUsd6(raw.SOFT_LIMIT_USD);
  const hard = usdToUsd6(raw.HARD_LIMIT_USD);
  if (soft >= hard) throw new ConfigError("SOFT_LIMIT_USD must be below HARD_LIMIT_USD");

  return {
    mode: raw.HEDGER_MODE,
    fillSource: raw.FILL_SOURCE,
    hedgeEnabled,
    bookMarket: raw.BOOK_MARKET,
    hedgeCoin: raw.HEDGE_COIN,
    bookApiUrl: raw.BOOK_API_URL,
    houseMakerTag: raw.HOUSE_MAKER_TAG,
    replayFile: raw.REPLAY_FILE,
    accountAddress: raw.HL_ACCOUNT_ADDRESS as `0x${string}` | undefined,
    agentPrivateKey: raw.HL_AGENT_PRIVATE_KEY as `0x${string}` | undefined,
    deadband8: BigInt(raw.DEADBAND_BTC8),
    maxOrder8: BigInt(raw.MAX_ORDER_BTC8),
    priceBandBps: raw.PRICE_BAND_BPS,
    softLimitUsd6: soft,
    hardLimitUsd6: hard,
    referenceMaxAgeMs: raw.REFERENCE_MAX_AGE_MS,
    confirmMaxAgeMs: raw.CONFIRM_MAX_AGE_MS,
    blindAfterMs: raw.BLIND_AFTER_MS,
    unknownOrderGraceMs: raw.UNKNOWN_ORDER_GRACE_MS,
    tickMs: raw.TICK_MS,
    leverageTarget: raw.HEDGE_LEVERAGE_TARGET,
    initialMakerPosition8: BigInt(raw.INITIAL_MAKER_POSITION_BTC8),
    journalFile: raw.JOURNAL_FILE,
    eventsFile: raw.EVENTS_FILE,
    cursorFile: raw.CURSOR_FILE,
    httpPort: raw.HTTP_PORT,
    keepAlive: raw.KEEP_ALIVE === "1",
  };
}

function resolveHedgeEnabled(flag: "0" | "1" | undefined, mode: "mock" | "testnet"): boolean {
  if (flag !== undefined) return flag === "1";
  if (mode === "mock") return true;
  throw new ConfigError('HEDGE_ENABLED must be set to exactly "0" or "1" in testnet mode');
}
