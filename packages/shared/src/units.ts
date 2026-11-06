import { z } from "zod";

export const USDC_DECIMALS = 6;
export const BTC_DECIMALS = 8;

const unsignedUnits = z.string().regex(/^\d+$/, "non-negative integer string in base units");
const signedUnits = z.string().regex(/^-?\d+$/, "integer string in base units");

export const usdc6 = unsignedUnits.describe("USDC amount in 6-decimal base units");
export const btc8 = unsignedUnits.describe("BTC size in 8-decimal base units, the same scale as WBTC");
export const signedBtc8 = signedUnits.describe("Signed BTC position in 8-decimal base units, long is positive");
export const signedUsdc6 = signedUnits.describe("Signed USDC amount in 6-decimal base units");
export const price = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "decimal string")
  .describe("BTC price in USD as a decimal string");

export function toBaseUnits(decimal: string, decimals: number): bigint {
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = decimal.replace(/^-/, "").split(".");
  if (fraction.length > decimals) {
    throw new Error(`${decimal} has more than ${decimals} decimals`);
  }
  const units = BigInt(whole + fraction.padEnd(decimals, "0"));
  return negative ? -units : units;
}

export function fromBaseUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
