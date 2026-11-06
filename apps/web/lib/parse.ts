import { bridgeTransfer, flowEvent, navSnapshot, type BridgeTransfer, type FlowEvent, type NavSnapshot } from "@noirwire/shared";
import { z } from "zod";

export const hedgerStatusResponse = z.object({
  status: z.enum(["hedged", "lagging", "blind", "halted"]),
  hedgeEnabled: z.boolean(),
  market: z.string(),
});
export type HedgerStatusResponse = z.infer<typeof hedgerStatusResponse>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; reason: string };

function fail(error: z.ZodError): { ok: false; reason: string } {
  const issue = error.issues[0];
  return { ok: false, reason: `unexpected response shape at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}` };
}

export function parseHedgerStatus(body: unknown): Parsed<HedgerStatusResponse> {
  const result = hedgerStatusResponse.safeParse(body);
  return result.success ? { ok: true, data: result.data } : fail(result.error);
}

export function parseTransfers(body: unknown): Parsed<BridgeTransfer[]> {
  const result = z.array(bridgeTransfer).safeParse(body);
  return result.success ? { ok: true, data: result.data } : fail(result.error);
}

export function parseNavSnapshot(body: unknown): Parsed<NavSnapshot> {
  const result = navSnapshot.safeParse(body);
  return result.success ? { ok: true, data: result.data } : fail(result.error);
}

export class SseParser {
  private buffer = "";
  skipped = 0;

  push(chunk: string): FlowEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: FlowEvent[] = [];
    let split = this.buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          const parsed = flowEvent.safeParse(JSON.parse(data));
          if (parsed.success) events.push(parsed.data);
          else this.skipped += 1;
        } catch {
          this.skipped += 1;
        }
      }
      split = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}
