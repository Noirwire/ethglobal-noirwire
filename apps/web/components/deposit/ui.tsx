import { useLive } from "../LiveProvider";
import { Rail, transferNodes } from "../TransferRail";
import { CHAIN_LABEL } from "@/lib/explorers";
import { formatUsdc } from "@/lib/format";
import { ATTESTER_LABEL, ROUTE_CHAINS } from "@/lib/transfers";

const STEP_LABELS = ["Connect", "Amount", "Confirm"] as const;

export function Steps({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="flex items-center gap-4 text-label" aria-label="Steps">
      {STEP_LABELS.map((label, index) => (
        <li key={label} className="flex items-center gap-2" aria-current={index === current ? "step" : undefined}>
          <span
            className={`tnum grid size-5 place-items-center rounded-full border text-[11px] ${
              index < current ? "border-ink-strong bg-ink-strong text-[color:var(--color-base)]" : index === current ? "border-ink-strong text-ink-strong" : "border-line text-faint"
            }`}
          >
            {index + 1}
          </span>
          <span className={index === current ? "text-ink-strong" : "text-faint"}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export const primaryButton =
  "bg-ink-strong text-[color:var(--color-base)] inline-flex min-h-10 items-center justify-center rounded-full px-5 text-body font-medium disabled:cursor-not-allowed disabled:opacity-40";
export const secondaryButton =
  "border-line text-dim hover:text-ink-strong inline-flex min-h-10 items-center justify-center rounded-full border px-5 text-body disabled:cursor-not-allowed disabled:opacity-40";

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="border-danger text-danger rounded-lg border px-3 py-2 text-label">
      {children}
    </p>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="border-line text-dim rounded-lg border px-3 py-2 text-label">
      {children}
    </p>
  );
}

export function Summary({ rows }: { rows: { term: string; value: React.ReactNode }[] }) {
  return (
    <dl className="border-line-subtle divide-line-subtle divide-y rounded-lg border">
      {rows.map((row) => (
        <div key={row.term} className="flex items-baseline justify-between gap-4 px-3 py-2">
          <dt className="text-faint text-label">{row.term}</dt>
          <dd className="tnum text-ink-strong min-w-0 break-all text-right text-body">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AmountField({
  value,
  onChange,
  error,
  hint,
  onMax,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  hint?: string;
  onMax?: () => void;
}) {
  return (
    <div>
      <label htmlFor="deposit-amount" className="text-faint text-label uppercase tracking-[0.12em]">
        Amount, USDC
      </label>
      <div className="border-line focus-within:border-line-strong bg-base mt-2 flex items-center rounded-lg border">
        <input
          id="deposit-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby="deposit-amount-note"
          className="tnum text-ink-strong min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[18px] outline-none"
        />
        {onMax && (
          <button type="button" onClick={onMax} className="text-dim hover:text-ink-strong px-3 text-label">
            Max
          </button>
        )}
      </div>
      <p id="deposit-amount-note" className={`mt-2 text-label ${error ? "text-danger" : "text-faint"}`}>
        {error ?? hint ?? "Up to 6 decimal places."}
      </p>
    </div>
  );
}

export function TransferTracker({ transferId }: { transferId: string }) {
  const { view } = useLive();
  const transfer = view.bridge.ok ? view.bridge.transfers.find((entry) => entry.id === transferId) : undefined;
  if (!transfer) {
    return (
      <Notice>
        {view.bridge.ok
          ? "Waiting for the bridge to list this transfer. It appears within a few seconds."
          : `Bridge not connected: ${view.bridge.reason}. The transfer continues on its own and shows on the Money page when it is back.`}
      </Notice>
    );
  }
  const chains = ROUTE_CHAINS[transfer.route];
  const local = transfer.attester === "local-test-attester";
  return (
    <section aria-label="Transfer progress" className="border-line-subtle rounded-lg border p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-ink-strong text-body">
          {CHAIN_LABEL[chains.from]} <span className="text-faint">to</span> {CHAIN_LABEL[chains.to]}
        </p>
        <p className="tnum text-ink-strong text-body">
          {formatUsdc(transfer.gross)} <span className="text-faint text-label">USDC</span>
        </p>
      </div>
      <Rail nodes={transferNodes(transfer)} />
      <div className="mt-4 flex flex-wrap items-center gap-2 text-label">
        <span
          className="border-line text-dim rounded-full border px-3 py-0.5"
          title={local ? "Attestation signed by a local test key, not by Circle" : "Attestation fetched from Circle's Iris service"}
        >
          {ATTESTER_LABEL[transfer.attester]}
        </span>
        {local && <span className="text-faint">local simulation, no public explorer</span>}
        {transfer.netMinted && <span className="tnum text-faint">net minted {formatUsdc(transfer.netMinted)}</span>}
      </div>
    </section>
  );
}
