"use client";

import { useState } from "react";
import { ArcDoor } from "./ArcDoor";
import { EvmDoor } from "./EvmDoor";
import { SolanaDoor } from "./SolanaDoor";

type Door = "arc" | "evm" | "solana";

const DOORS: { id: Door; title: string; note: string }[] = [
  { id: "arc", title: "Deposit from Arc", note: "Your EVM wallet approves USDC and requests the deposit directly." },
  { id: "evm", title: "Fund from Ethereum", note: "Burn USDC on Ethereum, Base or Arbitrum Sepolia; CCTP delivers it to the vault on Arc." },
  { id: "solana", title: "Deposit from Solana", note: "Burn USDC on Solana devnet; CCTP delivers it to the vault on Arc." },
];

export function Doors() {
  const [door, setDoor] = useState<Door | null>(null);
  const [visited, setVisited] = useState<Record<Door, boolean>>({ arc: false, evm: false, solana: false });
  return (
    <div className="space-y-5">
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
      <div hidden={door !== "evm"}>{visited.evm ? <EvmDoor /> : null}</div>
      <div hidden={door !== "solana"}>{visited.solana ? <SolanaDoor /> : null}</div>
    </div>
  );
}
