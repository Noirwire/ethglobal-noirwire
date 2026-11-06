"use client";

import { useLive } from "./LiveProvider";
import { Label, NotConnected, TrustTag } from "./parts";
import { Rail, transferNodes, type NodeView } from "./TransferRail";
import { CHAIN_LABEL } from "@/lib/explorers";
import { formatBtc, formatStamp, formatUsdc } from "@/lib/format";
import type { PublicBucket, PublicHedgeBucket } from "@/lib/privacy";
import { ATTESTER_LABEL, ROUTE_CHAINS } from "@/lib/transfers";
import type { PublicTransfer } from "@/lib/view-types";

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
                <TransferRow key={transfer.id}transfer={transfer} />
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
