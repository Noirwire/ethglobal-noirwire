import { fromBaseUnits } from "@noirwire/shared";

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUnits(units: string, decimals: number, places: number): string {
  const value = BigInt(units);
  const negative = value < 0n;
  const [whole = "0", fraction = ""] = fromBaseUnits(negative ? -value : value, decimals).split(".");
  const padded = fraction.padEnd(places, "0").slice(0, places);
  const body = places > 0 ? `${group(whole)}.${padded}` : group(whole);
  return negative ? `−${body}` : body;
}

export function formatBtc(units: string, signedDisplay = false): string {
  const text = formatUnits(units, 8, 2);
  return signedDisplay && BigInt(units) > 0n ? `+${text}` : text;
}

export function formatUsdc(units: string, places = 2): string {
  return formatUnits(units, 6, places);
}

export function formatSharePrice(priceE18: string): string {
  return formatUnits(priceE18, 18, 4);
}

export function formatClock(iso: string): string {
  return iso.slice(11, 19);
}

export function formatStamp(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
}
