import { loadEnv } from "../env";
import { parseHedgerStatus, parseTransfers } from "../parse";
import { aggregate, BUCKET_MS, PUBLISH_DELAY_MS } from "../privacy";
import { hedgerStatusLabel } from "../residual";
import { railFor } from "../transfers";
import type { Down, PublicTransfer, PublicView } from "../view-types";
import { feedFor } from "./hedger-feed";
import { readNav } from "./nav-source";
import { describeError, REQUEST_TIMEOUT_MS } from "./request";

const HEDGER_TTL_MS = 1000;
const BRIDGE_TTL_MS = 2000;
const NAV_TTL_MS = 10_000;

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(url: string): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

async function hedgerSection(): Promise<PublicView["hedger"]> {
  const env = loadEnv();
  const source = "Hedger";
  const feed = feedFor(env.hedgerUrl);
  const status = await getJson(`${env.hedgerUrl}/status`);
  if (!status.ok) return { ok: false, source, reason: `${env.hedgerUrl} not connected (${status.reason})` };
  const parsed = parseHedgerStatus(status.body);
  if (!parsed.ok) return { ok: false, source, reason: parsed.reason };
  if (!feed.connected) return { ok: false, source, reason: "event stream not connected" };
  const view = aggregate(feed.events, Date.now());
  return {
    ok: true,
    state: {
      status: hedgerStatusLabel(parsed.data.status),
      hedgeEnabled: parsed.data.hedgeEnabled,
      market: parsed.data.market,
      band: env.bandBtc8.toString(),
      latencySeconds: view.latencySeconds,
      buckets: view.buckets,
    },
  };
}

async function bridgeSection(): Promise<PublicView["bridge"]> {
  const env = loadEnv();
  const source = "Bridge";
  const response = await getJson(`${env.bridgeUrl}/v1/transfers`);
  if (!response.ok) return { ok: false, source, reason: `${env.bridgeUrl} not connected (${response.reason})` };
  const parsed = parseTransfers(response.body);
  if (!parsed.ok) return { ok: false, source, reason: parsed.reason };
  const transfers: PublicTransfer[] = parsed.data
    .map((transfer) => ({
      id: transfer.transferId,
      route: transfer.route,
      state: transfer.state,
      gross: transfer.grossAmount,
      netMinted: transfer.netMinted ?? null,
      fee: transfer.feeExecuted ?? null,
      attester: transfer.attester,
      updatedAt: transfer.updatedAt,
      rail: railFor(transfer),
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { ok: true, transfers };
}

export async function buildPublicView(): Promise<PublicView> {
  const [hedger, bridge, nav] = await Promise.all([
    cached("hedger", HEDGER_TTL_MS, hedgerSection),
    cached("bridge", BRIDGE_TTL_MS, bridgeSection),
    cached("nav", NAV_TTL_MS,() => readNav(loadEnv())),
  ]);
  return {
    privacy: { bucketSeconds: BUCKET_MS / 1000, roundBtc: "0.01", delaySeconds: PUBLISH_DELAY_MS / 1000 },
    hedger,
    bridge,
    nav: nav as Down | Extract<PublicView["nav"], { ok: true }>,
  };
}
