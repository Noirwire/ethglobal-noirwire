"use client";

import { useLive } from "./LiveProvider";
import { Sparkline } from "./Sparkline";
import { Label, NotConnected, Stat, TrustTag } from "./parts";
import { formatBtc, formatClock } from "@/lib/format";
import { axisRange8, deviationPercent, residualState } from "@/lib/residual";
import type { PublicBucket } from "@/lib/privacy";

const AXIS_HEADROOM_NUM = 5n;
const AXIS_HEADROOM_DEN = 4n;

interface BarSegment {
  from: bigint;
  to: bigint;
  className: string;
}

function DeviationRow({
  label,
  value,
  detail,
  segments,
  range,
  band8,
  inside,
  warn,
}: {
  label: string;
  value: bigint;
  detail?: string;
  segments: BarSegment[];
  range: bigint;
  band8: bigint;
  inside?: boolean;
  warn?: boolean;
}) {
  const bandPct = deviationPercent(band8, range) / 2;
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 md:grid-cols-[180px_1fr_160px]">
      <p className="text-dim text-body">{label}</p>
      <p className={`tnum text-body text-right md:order-3 ${warn ? "text-warning" : "text-ink-strong"}`}>
        {formatBtc(value.toString(), true)}
        {detail && <span className="text-faint block text-label">{detail}</span>}
      </p>
      <div className="relative col-span-2 h-3 md:order-2 md:col-span-1" aria-hidden>
        <div className="bg-surface-raised absolute inset-0 rounded-sm" />
        <div className="bg-elevated absolute inset-y-0 rounded-sm" style={{ left: `${50 - bandPct}%`, width: `${bandPct * 2}%` }} />
        <div className="bg-line-strong absolute inset-y-[-4px] left-1/2 w-px" />
        {inside ? (
          <div className="bg-ink-strong absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        ) : (
          segments.map((segment, index) => {
            const a = deviationPercent(segment.from, range) / 2;
            const b = deviationPercent(segment.to, range) / 2;
            return (
              <div
                key={index}
                className={`absolute inset-y-[3px] rounded-sm ${segment.className}`}
                style={{ left: `${50 + Math.min(a, b)}%`, width: `${Math.abs(b - a)}%` }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function latest(buckets: PublicBucket[]): PublicBucket | null {
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    const bucket = buckets[i];
    if (bucket && bucket.residual !== null) return bucket;
  }
  return null;
}

export function StateView() {
  const { view } = useLive();
  if (!view.hedger.ok) return <NotConnected down={view.hedger} />;
  const { state } = view.hedger;
  const band8 = BigInt(state.band);
  const current = latest(state.buckets);

  const facts = (
    <dl className="border-line-subtle grid grid-cols-1 gap-6 border-t pt-8 sm:grid-cols-3">
      <Stat term="Band threshold" value={`±${formatBtc(state.band)} BTC`} />
      <Stat
        term="Hedge latency"
        value={state.latencySeconds === null ? "n/a" : `${state.latencySeconds} s`}
        trust={{ label: "venue-api", note: "Median fill-to-hedge time from published buckets, reported by the hedger, in whole seconds" }}
      />
      <Stat
        term="Hedger"
        value={state.status.charAt(0).toUpperCase() + state.status.slice(1)}
        title={state.hedgeEnabled ? undefined : "Observing only, hedge orders are switched off"}
      />
    </dl>
  );

  if (!current || current.residual === null || current.makerPosition === null) {
    return (
      <div className="space-y-16">
        <section>
          <Label>Residual BTC</Label>
          <p className="text-faint text-display mt-4 font-semibold tracking-tight">n/a</p>
          <p className="text-faint mt-4 text-body">The hedger is connected but has not published an exposure reading yet.</p>
        </section>
        {facts}
      </div>
    );
  }

  const maker = BigInt(current.makerPosition);
  const hl = BigInt(current.hyperliquidPosition ?? "0");
  const aqua = BigInt(current.aquaInventory ?? "0");
  const residual = BigInt(current.residual);
  const hedgeNet = hl + aqua;
  const outside = residualState(residual, band8) === "outside";
  const range = (axisRange8([maker, hedgeNet, hl, aqua, residual], band8) * AXIS_HEADROOM_NUM) / AXIS_HEADROOM_DEN;

  return (
    <div className="space-y-16 md:space-y-20">
      <section aria-labelledby="residual-label">
        <div className="flex flex-wrap items-center gap-3">
          <span id="residual-label">
            <Label>Residual BTC</Label>
          </span>
          <TrustTag trust="venue-api" note="Positions are read by the hedger from the order book and Hyperliquid, then rounded and delayed" />
        </div>
        <p
          className={`tnum text-display mt-4 font-semibold tracking-tight ${outside ? "text-warning" : "text-ink-strong"}`}
          aria-live="polite"
        >
          {formatBtc(current.residual, true)}
        </p>
        <p className="text-dim mt-4 max-w-xl text-body">
          {outside
            ? "Outside the band. Maker net and hedge net no longer cancel."
            : "Inside the band. Maker net and hedge net cancel."}{" "}
          <span className="text-faint">As of {formatClock(current.start)} UTC, bucket start.</span>
        </p>
      </section>

      <section aria-label="Deviation from zero" className="space-y-6">
        <DeviationRow
          label="Maker net"
          value={maker}
          segments={[{ from: 0n, to: maker, className: "bg-dim" }]}
          range={range}
          band8={band8}
        />
        <DeviationRow
          label="Hedge net"
          value={hedgeNet}
          detail={`Hyperliquid perp ${formatBtc(hl.toString(), true)}, Aqua spot ${formatBtc(aqua.toString(), true)}`}
          segments={[
            { from: 0n, to: hl, className: "bg-dim" },
            { from: hl, to: hedgeNet, className: "bg-faint" },
          ]}
          range={range}
          band8={band8}
        />
        <DeviationRow
          label="Residual"
          value={residual}
          segments={[{ from: 0n, to: residual, className: "bg-warning" }]}
          range={range}
          band8={band8}
          inside={!outside}
          warn={outside}
        />
      </section>

      <section aria-label="Residual, last 15 minutes">
        <Sparkline buckets={state.buckets} band8={band8} />
      </section>

      {facts}
    </div>
  );
}
