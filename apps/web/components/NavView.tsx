"use client";

import { useLive } from "./LiveProvider";
import { Label, NotConnected, TrustTag } from "./parts";
import { shortHash } from "@/lib/explorers";
import { formatSharePrice, formatStamp, formatUsdc } from "@/lib/format";
import type { PublicNav, PublicNavSource } from "@/lib/view-types";

function SourceRow({ row }: { row: PublicNavSource }) {
  return (
    <li className="border-line-subtle grid grid-cols-2 gap-x-6 gap-y-2 border-t py-5 md:grid-cols-[130px_1fr_110px_110px_170px_130px]">
      <p className="text-ink-strong text-body col-span-2 md:col-span-1">{row.leg}</p>
      <p className="tnum text-dim col-span-2 min-w-0 truncate text-body md:col-span-1" title={row.account}>
        {row.accountHref ? (
          <a href={row.accountHref} target="_blank" rel="noreferrer" className="hover:text-ink-strong underline underline-offset-2">
            {row.account}
          </a>
        ) : (
          row.account
        )}
      </p>
      <Cell term="Assets" value={formatUsdc(row.assets)} />
      <Cell term="Liabilities" value={formatUsdc(row.liabilities)} />
      <Cell term="Observed" value={`${formatStamp(row.observedAt)} UTC`} />
      <div className="md:text-right">
        <TrustTag trust={row.trust} />
      </div>
    </li>
  );
}

function Cell({ term, value }: { term: string; value: string }) {
  return (
    <p className="tnum text-ink-strong text-body whitespace-nowrap md:text-right">
      <span className="text-faint mr-2 text-label md:hidden">{term}</span>
      {value}
    </p>
  );
}

function Ledger({ report }: { report: PublicNav }) {
  const { sources } = report;
  if (!sources.published) {
    return (
      <div className="border-line rounded-xl border border-dashed p-6" role="status">
        <p className="text-ink-strong text-body">Per-source breakdown not published</p>
        <p className="text-faint mt-1 text-label">{sources.reason}</p>
      </div>
    );
  }
  return (
    <div>
      <div className="text-faint hidden grid-cols-[130px_1fr_110px_110px_170px_130px] gap-x-6 pb-3 text-label uppercase tracking-[0.12em] md:grid">
        <span>Leg</span>
        <span>Account</span>
        <span className="text-right">Assets</span>
        <span className="text-right">Liabilities</span>
        <span className="text-right">Observed</span>
        <span className="text-right">Trust</span>
      </div>
      <ul>
        {sources.rows.map((row) => (
          <SourceRow key={`${row.leg}-${row.account}`} row={row} />
        ))}
      </ul>
    </div>
  );
}

export function NavView() {
  const { view } = useLive();
  if (!view.nav.ok) return <NotConnected down={view.nav} />;
  const { report } = view.nav;
  const hashCheck = report.sources.published ? report.sources : null;

  return (
    <div className="space-y-16">
      <section>
        <Label>Close {report.closeId}, NAV ledger</Label>
        <div className="mt-6">
          <Ledger report={report} />
        </div>
      </section>

      <section className="border-line-strong border-t pt-8">
        <div className="mb-6 flex items-center gap-3">
          <Label>Totals from the onchain report</Label>
          <TrustTag trust="onchain" note="Written to the NavReceiver on Arc by the Chainlink CRE workflow. The inputs carry their own labels above." />
        </div>
        <dl className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <Total term="Total assets" value={`${formatUsdc(report.totalAssets)} USDC`} />
          <Total term="Liabilities" value={`${formatUsdc(report.totalLiabilities)} USDC`} />
          <Total
            term="Share price"
            value={report.sharePriceE18 === null ? "n/a" : `${formatSharePrice(report.sharePriceE18)} USD`}
            note={report.sharePriceE18 === null ? "Settlement for this close not found on the vault" : undefined}
          />
          <Total term="Observed" value={`${formatStamp(report.observedAt)} UTC`} />
        </dl>
        <dl className="mt-10 space-y-6">
          <div>
            <dt className="text-faint text-label uppercase tracking-[0.12em]">Sources hash</dt>
            <dd className="tnum text-ink-strong mt-1 break-all text-body">{report.sourcesHash}</dd>
            {hashCheck && (
              <dd className={`mt-1 text-label ${hashCheck.hashMatches ? "text-safe" : "text-danger"}`}>
                {hashCheck.hashMatches
                  ? "Recomputed from the published sources: matches the onchain hash."
                  : `Recomputed hash ${shortHash(hashCheck.recomputedHash)} does not match the onchain hash.`}
              </dd>
            )}
          </div>
          <div>
            <dt className="text-faint text-label uppercase tracking-[0.12em]">CRE report transaction on Arc</dt>
            <dd className="tnum text-ink-strong mt-1 break-all text-body">
              {report.reportTxHref ? (
                <a href={report.reportTxHref} target="_blank" rel="noreferrer" className="hover:text-dim underline underline-offset-2">
                  {report.reportTx}
                </a>
              ) : (
                report.reportTx
              )}
            </dd>
            {!report.reportTxHref && <dd className="text-faint mt-1 text-label">Local chain, no public explorer.</dd>}
          </div>
        </dl>
        <p className="text-dim mt-8 max-w-xl text-body">
          Anyone can recompute the hash: keccak256 of the ABI-encoded source records, sorted by leg and account, must equal the
          value the report wrote to Arc.
        </p>
      </section>
    </div>
  );
}

function Total({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-faint text-label uppercase tracking-[0.12em]">{term}</dt>
      <dd className="tnum text-ink-strong mt-1 text-body">{value}</dd>
      {note && <dd className="text-faint mt-1 text-label">{note}</dd>}
    </div>
  );
}
