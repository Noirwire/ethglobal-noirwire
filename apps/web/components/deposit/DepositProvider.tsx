"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Doors } from "./Doors";

const DepositContext = createContext<{ open: () => void } | null>(null);

export function useDeposit(): { open: () => void } {
  const value = useContext(DepositContext);
  if (!value) throw new Error("useDeposit must be used inside DepositProvider");
  return value;
}

export function DepositProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (isOpen && !element.open) element.showModal();
    if (!isOpen && element.open) element.close();
  }, [isOpen]);

  const open = useCallback(() => setOpen(true), []);

  return (
    <DepositContext.Provider value={{ open }}>
      {children}
      <dialog
        ref={dialog}
        aria-labelledby="deposit-title"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        className="bg-surface-raised border-line text-ink m-auto max-h-[calc(100dvh-1.5rem)] w-[min(34rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border p-0"
      >
        <div className="space-y-5 p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="deposit-title" className="text-ink-strong text-[18px] font-semibold tracking-tight">
                Deposit USDC
              </h2>
              <p className="text-faint mt-1 text-label">Test USDC only. Requests are settled at the next close. You hold shares once it settles.</p>
              <Link href="/fund" onClick={() => setOpen(false)} className="text-dim hover:text-ink-strong mt-2 inline-block text-label underline underline-offset-4">
                Open the funding page
              </Link>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-dim hover:text-ink-strong text-label" aria-label="Close deposit">
              Close
            </button>
          </div>
          <Doors />
        </div>
      </dialog>
    </DepositContext.Provider>
  );
}
