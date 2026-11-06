import { toBaseUnits, USDC_DECIMALS } from "@noirwire/shared";

type ParsedAmount = { ok: true; units: bigint } | { ok: false; reason: string };

const U64_MAX = 2n ** 64n - 1n;

export function parseUsdcAmount(text: string): ParsedAmount {
  const value = text.trim();
  if (value === "") return { ok: false, reason: "Enter an amount." };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(value)) return { ok: false, reason: "Use digits and at most one decimal point." };
  const [, fraction = ""] = value.split(".");
  if (fraction.length > USDC_DECIMALS) {
    return { ok: false, reason: `USDC has ${USDC_DECIMALS} decimals. Use at most ${USDC_DECIMALS} decimal places.` };
  }
  const units = toBaseUnits(value.startsWith(".") ? `0${value}` : value, USDC_DECIMALS);
  if (units === 0n) return { ok: false, reason: "The amount must be above zero." };
  if (units > U64_MAX) return { ok: false, reason: "That amount is too large." };
  return { ok: true, units };
}
