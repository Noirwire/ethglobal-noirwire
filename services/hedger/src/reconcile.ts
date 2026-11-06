import type { JournalOrder } from "./journal.ts";
import type { HedgeVenue } from "./types.ts";

const FILL_LOOKBACK_MS = 1_000;

export type SettledFinal = "filled" | "partial" | "cancelled" | "rejected" | "not-placed";

export type Resolution =
  | { kind: "settled"; final: SettledFinal; filled8: bigint; avgPx8?: bigint }
  | { kind: "cancel-failed" }
  | { kind: "pending" };

type Log = (message: string) => void;

export function settledFinal(
  state: "filled" | "cancelled" | "rejected",
  filled8: bigint,
  size8: bigint,
): "filled" | "partial" | "cancelled" | "rejected" {
  if (state === "rejected") return "rejected";
  if (filled8 >= size8) return "filled";
  if (filled8 > 0n) return "partial";
  return state === "filled" ? "filled" : "cancelled";
}

export async function attemptCancel(venue: HedgeVenue, cloid: string, log: Log): Promise<boolean> {
  try {
    await venue.cancelByCloid(cloid);
    return true;
  } catch (error) {
    log(`cancel failed for ${cloid}: ${String(error)}`);
    return false;
  }
}

async function findFilledSizeByCloid(venue: HedgeVenue, order: JournalOrder): Promise<bigint | null> {
  try {
    const fills = await venue.fillsSince(order.intentAt - FILL_LOOKBACK_MS);
    const matching = fills.filter((fill) => fill.cloid === order.cloid);
    if (matching.length === 0) return null;
    return matching.reduce((sum, fill) => sum + fill.size8, 0n);
  } catch {
    return null;
  }
}

export async function resolveOrder(
  venue: HedgeVenue,
  order: JournalOrder,
  now: number,
  unknownOrderGraceMs: number,
  log: Log,
): Promise<Resolution> {
  let status;
  try {
    status = await venue.orderStatusByCloid(order.cloid);
  } catch (error) {
    log(`status unavailable for ${order.cloid}: ${String(error)}`);
    return { kind: "pending" };
  }

  if (status.state === "filled" || status.state === "cancelled" || status.state === "rejected") {
    return {
      kind: "settled",
      final: settledFinal(status.state, status.filled8, order.size8),
      filled8: status.filled8,
      avgPx8: status.avgPx8,
    };
  }

  if (status.state === "open") {
    if (!(await attemptCancel(venue, order.cloid, log))) return { kind: "cancel-failed" };
    const after = await venue.orderStatusByCloid(order.cloid).catch(() => null);
    if (after && after.state !== "open" && after.state !== "unknown") {
      return {
        kind: "settled",
        final: settledFinal(after.state, after.filled8, order.size8),
        filled8: after.filled8,
        avgPx8: after.avgPx8,
      };
    }
    return { kind: "pending" };
  }

  const found = await findFilledSizeByCloid(venue, order);
  if (found !== null) {
    return { kind: "settled", final: found >= order.size8 ? "filled" : "partial", filled8: found };
  }
  if (now - order.intentAt >= unknownOrderGraceMs) {
    return { kind: "settled", final: "not-placed", filled8: 0n };
  }
  return { kind: "pending" };
}
