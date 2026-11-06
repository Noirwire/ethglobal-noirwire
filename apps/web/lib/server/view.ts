import { loadEnv } from "../env";
import { parseHedgerStatus, parseTransfers } from "../parse";
import { aggregate, BUCKET_MS, PUBLISH_DELAY_MS } from "../privacy";
import { hedgerStatusLabel } from "../residual";
import { publicTransfers } from "../transfers";
import type { Down, PublicView } from "../view-types";
import { cached } from "./cache";
import { feedFor } from "./hedger-feed";
import { readNav } from "./nav-source";
import { describeError, REQUEST_TIMEOUT_MS } from "./request";

const HEDGER_TTL_MS = 1000;
const BRIDGE_TTL_MS = 2000;
const NAV_TTL_MS = 10_000;

async function getJson(source: string, url: string): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      console.error(`${source}: ${url} responded HTTP ${response.status}`);
      return { ok: false };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    console.error(`${source}: ${url} unreachable (${describeError(error)})`);
    return { ok: false };
  }
}

async function hedgerSection(): Promise<PublicView["hedger"]> {
  const env = loadEnv();
  const source = "Hedger";
  const feed = feedFor(env.hedgerUrl);
  const status = await getJson(source, `${env.hedgerUrl}/status`);
  if (!status.ok) return { ok: false, source, reason: "no response from the service" };
  const parsed = parseHedgerStatus(status.body);
  if (!parsed.ok) {
    console.error(`${source}: invalid status (${parsed.reason})`);
    return { ok: false, source, reason: "unexpected response" };
  }
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
  const response = await getJson(source, `${env.bridgeUrl}/v1/transfers`);
  if (!response.ok) return { ok: false, source, reason: "no response from the service" };
  const parsed = parseTransfers(response.body);
  if (!parsed.ok) {
    console.error(`${source}: invalid transfers (${parsed.reason})`);
    return { ok: false, source, reason: "unexpected response" };
  }
  return { ok: true, transfers: publicTransfers(parsed.data, Date.now()) };
}

export async function buildPublicView(): Promise<PublicView> {
  const [hedger, bridge, nav] = await Promise.all([
    cached("hedger", HEDGER_TTL_MS, hedgerSection),
    cached("bridge", BRIDGE_TTL_MS, bridgeSection),
    cached("nav", NAV_TTL_MS, () => readNav(loadEnv())),
  ]);
  return {
    privacy: { bucketSeconds: BUCKET_MS / 1000, roundBtc: "0.01", delaySeconds: PUBLISH_DELAY_MS / 1000 },
    hedger,
    bridge,
    nav: nav as Down | Extract<PublicView["nav"], { ok: true }>,
  };
}
