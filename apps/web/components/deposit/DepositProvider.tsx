"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ArcDoor } from "./ArcDoor";
import { SolanaDoor } from "./SolanaDoor";

type Door = "arc" | "solana";

const DepositContext = createContext<{ open: () => void } | null>(null);

export function useDeposit(): { open: () => void } {
  const value = useContext(DepositContext);
  if (!value) throw new Error("useDeposit must be used inside DepositProvider");
  return value;
}

const DOORS: { id: Door; title: string; note: string }[] = [
  { id: "arc", title: "Deposit from Arc", note: "Your EVM wallet approves USDC and requests the deposit directly." },
  { id: "solana", title: "Deposit from Solana", note: "Burn USDC on Solana devnet; CCTP delivers it to the vault on Arc." },
];

export function DepositProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [door, setDoor] = useState<Door | null>(null);
  const [visited, setVisited] = useState({ arc: false, solana: false });
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
              <p className="text-faint mt-1 text-label">Requests are settled at the next close. You hold shares once it settles.</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-dim hover:text-ink-strong text-label" aria-label="Close deposit">
              Close
            </button>
          </div>

          {door === null && (
            <ul className="space-y-2">
              {DOORS.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setDoor(entry.id);
                      setVisited((seen) => ({ ...seen, [entry.id]: true }));
                    }}
                    className="border-line hover:border-line-strong w-full rounded-lg border px-4 py-3 text-left"
                  >
                    <span className="text-ink-strong block text-body">{entry.title}</span>
                    <span className="text-faint block text-label">{entry.note}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {door !== null && (
            <button type="button" onClick={() => setDoor(null)} className="text-dim hover:text-ink-strong text-label underline underline-offset-4">
              All options
            </button>
          )}
          <div hidden={door !== "arc"}>{visited.arc ? <ArcDoor /> : null}</div>
          <div hidden={door !== "solana"}>{visited.solana ? <SolanaDoor /> : null}</div>
        </div>
      </dialog>
    </DepositContext.Provider>
  );
}
