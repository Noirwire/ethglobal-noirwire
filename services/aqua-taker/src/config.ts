import { type Address, isAddress } from "viem";
import { z } from "zod";
import { DEFAULT_FORK_RPC } from "./chain.js";

const evmAddress = z.custom<Address>((value) => typeof value === "string" && isAddress(value, { strict: false }));

const oracleMode = z.enum(["test-aggregator", "chainlink"]);
export type OracleMode = z.infer<typeof oracleMode>;

const envSchema = z.object({
  AQUA_FORK_RPC: z.url().default(DEFAULT_FORK_RPC),
  AQUA_ORACLE: oracleMode.default("test-aggregator"),
  AQUA_TAKER_GATE_TOKEN: evmAddress.optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return envSchema.parse({
    AQUA_FORK_RPC: env.AQUA_FORK_RPC,
    AQUA_ORACLE: env.AQUA_ORACLE,
    AQUA_TAKER_GATE_TOKEN: env.AQUA_TAKER_GATE_TOKEN,
  });
}
