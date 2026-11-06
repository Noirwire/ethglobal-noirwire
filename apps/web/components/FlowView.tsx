"use client";

import { useLive } from "./LiveProvider";
import { Label, NotConnected, TrustTag } from "./parts";
import { CHAIN_LABEL, shortHash } from "@/lib/explorers";
import { formatBtc, formatClock, formatStamp, formatUsdc } from "@/lib/format";
import type { PublicBucket, PublicHedgeBucket } from "@/lib/privacy";
import { ATTESTER_LABEL, ROUTE_CHAINS, STAGE_LABEL, type RailNode } from "@/lib/transfers";
import type { PublicTransfer } from "@/lib/view-types";

interface NodeView {
  key: string;
  label: string;
  reached: boolean;
  tone: "normal" | "danger" | "warning";
  hash: string | null;
  href: string | null;
  at: string | null;
  note?: string;
}

function Node({ node }: { node: NodeView }) {
  const dot = node.tone === "danger" ? "border-danger bg-danger" : node.tone === "warning" ? "border-warning" : node.reached ? "border-ink-strong bg-ink-strong" : "border-line";
  const text = node.tone === "danger" ? "text-danger" : node.reached ? "text-ink-strong" : "text-faint";
  return (
    <li className="relative min-w-0 pt-5">
      <span className={`rail-node absolute left-0 top-0 size-3 rounded-full border-2 ${dot}`} aria-hidden />
      <p className={`rail-label text-body ${text}`}>
        {node.label}
        <span className="sr-only">{node.reached ? ", reached" : ", pending"}</span>
      </p>
      {node.hash &&
        (node.href ? (
          <a href={node.href} target="_blank" rel="noreferrer" className="tnum text-dim hover:text-ink-strong block truncate text-label underline underline-offset-2" title={node.hash}>
            {shortHash(node.hash)}
          </a>
        ) : (
          <span className="tnum text-faint block truncate text-label" title={node.hash}>
            {shortHash(node.hash)}
          </span>
        ))}
      {node.at && (
        <time className="tnum text-faint block text-label" dateTime={node.at} title={node.at}>
          {formatClock(node.at)}
        </time>
      )}
      {node.note && <span className="text-faint block text-label">{node.note}</span>}
    </li>
  );
}

function Rail({ nodes }: { nodes: NodeView[] }) {
  return (
    <div className="relative">
      <div className="bg-line absolute left-1.5 right-1.5 top-[5px] h-px" aria-hidden />
      <ol className="relative grid gap-3" style={{ gridTemplateColumns: `repeat(${nodes.length}, minmax(0, 1fr))` }}>
        {nodes.map((node) => (
          <Node key={node.key} node={node} />
        ))}
      </ol>
    </div>
  );
}

function transferNodes(transfer: PublicTransfer): NodeView[] {
  const failedAt = transfer.rail.terminal?.kind === "failed" ? transfer.rail.nodes.findIndex((node) => !node.reached) : -1;
  return transfer.rail.nodes.map((node: RailNode, index): NodeView => {
    if (index === failedAt) {
      return {
        key: "failed",
        label: "Failed",
        reached: true,
        tone: "danger",
        hash: node.hash,
        href: node.href,
        at: transfer.updatedAt,
        note: transfer.rail.terminal?.error ?? undefined,
      };
    }
    return {
      key: node.stage,
      label: STAGE_LABEL[node.stage],
      reached: node.reached,
      tone: node.stalled ? "warning" : "normal",
      hash: node.hash,
      href: node.href,
      at: node.at,
      note: node.stalled ? "stalled" : undefined,
    };
  });
}

function TransferRow({ transfer }: { transfer: PublicTransfer }) {
  const chains = ROUTE_CHAINS[transfer.route];
  const local = transfer.attester === "local-test-attester";
  return (
    <li className="border-line-subtle border-t py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-ink-strong text-body">
          {CHAIN_LABEL[chains.from]} <span className="text-faint">to</span> {CHAIN_LABEL[chains.to]}
        </p>
        <p className="tnum text-ink-strong text-body">
          {formatUsdc(transfer.gross)} <span className="text-faint text-label">USDC</span>
        </p>
      </div>
      <Rail nodes={transferNodes(transfer)} />
      <div className="mt-5 flex flex-wrap items-center gap-2 text-label">
        <span className="border-line text-dim rounded-full border px-3 py-0.5" title={local ? "Attestation signed by a local test key, not by Circle" : "Attestation fetched from Circle's Iris service"}>
          {ATTESTER_LABEL[transfer.attester]}
        </span>
        <TrustTag trust="operator-supplied" note="Amounts are reported by the bridge service. Verify them at the linked transactions." />
        {transfer.netMinted && <span className="tnum text-faint">net minted {formatUsdc(transfer.netMinted)}</span>}
        {local && <span className="text-faint">local chain, no public explorer</span>}
      </div>
    </li>
  );
}

function hedgeNodes(hedge: PublicHedgeBucket, bucket: PublicBucket): NodeView[] {
  const at = bucket.start;
  const nodes: NodeView[] = [
    { key: "sent", label: "Sent", reached: true, tone: "normal", hash: null, href: null, at },
  ];
  if (hedge.rejected > 0) {
    nodes.push({
      key: "rejected",
      label: "Rejected",
      reached: true,
      tone: "danger",
      hash: null,
      href: null,
      at: null,
      note: hedge.rejected === hedge.orders ? undefined : `${hedge.rejected} of ${hedge.orders}`,
    });
  } else {
    nodes.push({ key: "filled", label: "Filled", reached: true, tone: "normal", hash: null, href: null, at: null });
  }
  return nodes;
}

const VENUE_LABEL = { hyperliquid: "Hyperliquid perp", aqua: "Aqua spot" } as const;

function HedgeRow({ bucket, hedge }: { bucket: PublicBucket; hedge: PublicHedgeBucket }) {
  return (
    <li className="border-line-subtle border-t py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-ink-strong text-body">
          Hedge, {VENUE_LABEL[hedge.venue]} <span className="text-faint">bucket {formatStamp(bucket.start)} UTC</span>
        </p>
        <p className="tnum text-ink-strong text-body">
          {formatBtc(hedge.net, true)} <span className="text-faint text-label">BTC net</span>
        </p>
      </div>
      <div className="max-w-md">
        <Rail nodes={hedgeNodes(hedge, bucket)} />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2 text-label">
        <TrustTag trust="venue-api" note="Reported by the hedger from venue responses, rounded and netted per bucket" />
        <span className="tnum text-faint">maker flow {formatBtc(bucket.makerFlow, true)} BTC</span>
      </div>
    </li>
  );
}

export function FlowView() {
  const { view } = useLive();
  const hedgeRows =
    view.hedger.ok
      ? view.hedger.state.buckets
          .flatMap((bucket) => bucket.hedges.map((hedge) => ({ bucket, hedge })))
          .reverse()
          .slice(0, 12)
      : [];

  return (
    <div className="space-y-20">
      <section>
        <Label>Bridge transfers</Label>
        <div className="mt-6">
          {!view.bridge.ok ? (
            <NotConnected down={view.bridge} />
          ) : view.bridge.transfers.length === 0 ? (
            <p className="text-dim border-line-subtle border-t pt-8 text-body">No transfers yet.</p>
          ) : (
            <ul>
              {view.bridge.transfers.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <Label>Hedges</Label>
        <div className="mt-6">
          {!view.hedger.ok ? (
            <NotConnected down={view.hedger} />
          ) : hedgeRows.length === 0 ? (
            <p className="text-dim border-line-subtle border-t pt-8 text-body">No published hedges in the last 15 minutes.</p>
          ) : (
            <ul>
              {hedgeRows.map(({ bucket, hedge }) => (
                <HedgeRow key={`${bucket.start}-${hedge.venue}`} bucket={bucket} hedge={hedge} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
