"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDeposit } from "./deposit/DepositProvider";
import { useLive } from "./LiveProvider";
import type { HedgerStatus } from "@/lib/residual";

const LINKS = [
  { href: "/", label: "State" },
  { href: "/flow", label: "Money" },
  { href: "/nav", label: "Proof" },
] as const;

const STATUS_DOT: Record<HedgerStatus, string> = {
  hedged: "bg-safe",
  hedging: "bg-warning",
  blind: "bg-warning",
  halted: "bg-danger",
};

function StatusChip() {
  const { view, streaming } = useLive();
  let label = "Not connected";
  let dot = "bg-faint";
  let live = false;
  if (!streaming) {
    label = "Reconnecting";
  } else if (view.hedger.ok) {
    label = view.hedger.state.status;
    dot = STATUS_DOT[view.hedger.state.status];
    live = true;
  }
  return (
    <span
      className="border-line text-dim inline-flex items-center gap-2 rounded-full border px-3 py-1 text-label"
      title={view.hedger.ok ? "Hedger status" : view.hedger.reason}
    >
      <span className={`${dot} ${live ? "live-dot" : ""} size-2 rounded-full`} aria-hidden />
      <span className="capitalize">{label}</span>
    </span>
  );
}

function PrivacyChip() {
  const { view } = useLive();
  const { bucketSeconds, roundBtc, delaySeconds } = view.privacy;
  return (
    <span className="has-tip relative inline-flex">
      <button
        type="button"
        aria-describedby="privacy-tip"
        className="border-line text-faint hover:text-dim rounded-full border px-3 py-1 text-left text-label"
      >
        {bucketSeconds} s buckets, sizes rounded to {roundBtc} BTC, {delaySeconds} s delay
      </button>
      <span
        id="privacy-tip"
        role="tooltip"
        className="tip bg-elevated border-line text-dim absolute left-0 top-full z-10 mt-2 w-[min(22rem,calc(100vw-2.5rem))] rounded-lg border p-3 text-label"
      >
        Fills and hedges are grouped into {bucketSeconds} second buckets. Sizes are rounded to {roundBtc} BTC, hedges are
        netted per bucket, and a bucket is published only once it is {delaySeconds} seconds old. Individual fills, exact
        sizes and exact times never leave the server, so the public view cannot be used to trade against the maker.
      </span>
    </span>
  );
}

export function Header() {
  const pathname = usePathname();
  return (
    <header className="border-line-subtle border-b">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-5 py-5 md:px-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-8">
            <span className="text-ink-strong text-body font-semibold tracking-tight">NoirWire</span>
            <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
              <NavLinks pathname={pathname} />
            </nav>
          </div>
          <StatusChip />
        </div>
        <nav aria-label="Primary" className="flex items-center gap-6 md:hidden">
          <NavLinks pathname={pathname} />
        </nav>
        <div>
          <PrivacyChip />
        </div>
      </div>
    </header>
  );
}

function NavLinks({ pathname }: { pathname: string }) {
  const { open } = useDeposit();
  return (
    <>
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`text-body ${active ? "text-ink-strong underline decoration-1 underline-offset-8" : "text-dim hover:text-ink-strong"}`}
          >
            {link.label}
          </Link>
        );
      })}
      <button type="button" onClick={open} className="text-dim hover:text-ink-strong text-body">
        Deposit
      </button>
    </>
  );
}
