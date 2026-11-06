import type { TrustLabel } from "@noirwire/shared";
import { formatUsdc } from "@/lib/format";
import { ATTESTER_LABEL } from "@/lib/transfers";
import type { Down, PublicTransfer } from "@/lib/view-types";

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

export function TransferAmount({ gross, children }: { gross: string; children?: React.ReactNode }) {
  return (
    <p className="tnum text-ink-strong text-body">
      {formatUsdc(gross)} <span className="text-faint text-label">USDC</span>
      {children}
    </p>
  );
}

export function AttesterBadge({ attester }: { attester: PublicTransfer["attester"] }) {
  const local = attester === "local-test-attester";
  return (
    <span
      className="border-line text-dim rounded-full border px-3 py-0.5"
      title={local ? "Attestation signed by a local test key, not by Circle" : "Attestation fetched from Circle's Iris service"}
    >
      {ATTESTER_LABEL[attester]}
    </span>
  );
}

export function NetMinted({ netMinted }: { netMinted: string | null }) {
  if (!netMinted) return null;
  return <span className="tnum text-faint">net minted {formatUsdc(netMinted)}</span>;
}

export function Stat({
  term,
  value,
  note,
  title,
  trust,
}: {
  term: string;
  value: string;
  note?: string;
  title?: string;
  trust?: { label: TrustLabel; note: string };
}) {
  return (
    <div title={title}>
      <dt className="text-faint text-label uppercase tracking-[0.12em]">{term}</dt>
      <dd className="tnum text-ink-strong mt-1 text-body">{value}</dd>
      {trust && (
        <dd className="mt-1">
          <TrustTag trust={trust.label} note={trust.note} />
        </dd>
      )}
      {note && <dd className="text-faint mt-1 text-label">{note}</dd>}
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-faint text-label uppercase tracking-[0.12em]">{children}</p>;
}
