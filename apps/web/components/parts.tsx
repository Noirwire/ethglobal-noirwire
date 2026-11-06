import type { TrustLabel } from "@noirwire/shared";
import type { Down } from "@/lib/view-types";

export function NotConnected({ down }: { down: Down }) {
  return (
    <div className="border-line rounded-xl border border-dashed p-6" role="status">
      <p className="text-ink-strong text-body">{down.source} not connected</p>
      <p className="text-faint mt-1 text-label">{down.reason}</p>
      <p className="text-faint mt-1 text-label">No numbers are shown for this source until it responds.</p>
    </div>
  );
}

export function TrustTag({ trust, note }: { trust: TrustLabel; note?: string }) {
  return (
    <span className="border-line text-faint inline-flex rounded-full border px-2 text-label" title={note}>
      {trust}
    </span>
  );
}

export function Stat({ term, value, note, title }: { term: string; value: string; note?: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-faint text-label uppercase tracking-[0.12em]">{term}</dt>
      <dd className="tnum text-ink-strong mt-1 text-body">{value}</dd>
      {note && <dd className="text-faint mt-1 text-label">{note}</dd>}
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-faint text-label uppercase tracking-[0.12em]">{children}</p>;
}
