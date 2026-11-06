"use client";

import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { AmountField, ErrorNote, Notice, primaryButton, secondaryButton, Steps, Summary, TransferTracker } from "./ui";
import { parseUsdcAmount } from "@/lib/deposit/amount";
import {
  fetchSolanaStatus,
  prepareSolanaDeposit,
  simulateLocalDeposit,
  submitSolanaBurn,
  type SolanaStatus,
} from "@/lib/deposit/api";
import {
  connectSolana,
  explainSolanaError,
  onWalletsChanged,
  signAndSendBase64,
  solanaWalletsInBrowser,
  type StandardAccount,
  type StandardWallet,
} from "@/lib/deposit/solana-wallet";
import { shortHash } from "@/lib/explorers";
import { formatUsdc } from "@/lib/format";

const REGISTER_ATTEMPTS = 10;
const REGISTER_WAIT_MS = 2500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Phase = "idle" | "connecting" | "preparing" | "signing" | "registering" | "simulating";

export function SolanaDoor() {
  const [status, setStatus] = useState<SolanaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSolanaStatus().then((result) => {
      if (cancelled) return;
      if (result.ok) setStatus(result.data);
      else setStatusError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (statusError) return <ErrorNote>{statusError}</ErrorNote>;
  if (!status) return <p className="text-faint text-body">Checking the bridge</p>;
  return <SolanaFlow status={status} />;
}

function SolanaFlow({ status }: { status: SolanaStatus }) {
  const local = status.mode === "local";
  const [wallets, setWallets] = useState<{ usable: StandardWallet[]; unusable: string[] }>({ usable: [], unusable: [] });
  const [wallet, setWallet] = useState<StandardWallet | null>(null);
  const [account, setAccount] = useState<StandardAccount | null>(null);
  const [localReady, setLocalReady] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);

  useEffect(() => {
    if (local) return;
    const read = () => setWallets(solanaWalletsInBrowser());
    const ready = setTimeout(read, 0);
    const off = onWalletsChanged(read);
    return () => {
      clearTimeout(ready);
      off();
    };
  }, [local]);

  const parsed = parseUsdcAmount(amountText);
  const amountError = amountText.trim() === "" || parsed.ok ? null : parsed.reason;
  const beneficiaryValid = isAddress(beneficiary.trim());
  const beneficiaryError =
    local || beneficiary.trim() === "" || beneficiaryValid ? null : "Enter the Arc address (0x followed by 40 hex characters) that receives the vault position.";
  const connected = local ? localReady : account !== null;
  const canReview = parsed.ok && (local || beneficiaryValid);

  const connect = async (chosen: StandardWallet) => {
    setError(null);
    setPhase("connecting");
    try {
      setAccount(await connectSolana(chosen));
      setWallet(chosen);
    } catch (cause) {
      setError(explainSolanaError(cause));
    } finally {
      setPhase("idle");
    }
  };

  const simulate = async () => {
    if (!parsed.ok) return;
    setError(null);
    setPhase("simulating");
    const result = await simulateLocalDeposit(parsed.units.toString());
    setPhase("idle");
    if (!result.ok) return setError(result.error);
    const first = result.data.transfers[0];
    if (!first) return setError("The bridge started no transfer. Check the bridge log.");
    setTransferId(first.transferId);
  };

  const signAndSend = async () => {
    if (!wallet || !account || !parsed.ok) return;
    setError(null);
    setPhase("preparing");
    const prepared = await prepareSolanaDeposit({ owner: account.address, amount: parsed.units.toString(), beneficiary: beneficiary.trim() });
    if (!prepared.ok) {
      setPhase("idle");
      return setError(prepared.error);
    }
    setPhase("signing");
    let signature: string;
    try {
      signature = await signAndSendBase64(wallet, account, prepared.data.transaction);
    } catch (cause) {
      setPhase("idle");
      return setError(explainSolanaError(cause));
    }
    setPhase("registering");
    for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
      const registered = await submitSolanaBurn(signature);
      if (registered.ok) {
        setPhase("idle");
        return setTransferId(registered.data.transfer.transferId);
      }
      if (registered.status !== 404) {
        setPhase("idle");
        return setError(`The burn was sent (${shortHash(signature)}) but the bridge did not accept it: ${registered.error}`);
      }
      await sleep(REGISTER_WAIT_MS);
    }
    setPhase("idle");
    setError(`The burn was sent (${signature}) but is not visible on Solana devnet yet, so the bridge has not picked it up. It will not be lost; keep the signature.`);
  };

  if (transferId) {
    return (
      <div className="space-y-4">
        <Steps current={2} />
        <TransferTracker transferId={transferId} />
        <p className="text-faint text-label">
          When the rail reaches Credited, the deposit is a pending request in the vault, priced at the next close.
        </p>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            setTransferId(null);
            setReviewing(false);
            setAmountText("");
          }}
        >
          Deposit more
        </button>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="space-y-4">
        <Steps current={0} />
        {local ? (
          <>
            <Notice>This bridge runs on a local chain, so there is no Solana burn to sign. You can simulate a deposit instead: it uses a local test attester, not Circle.</Notice>
            <button type="button" className={primaryButton} onClick={() => setLocalReady(true)}>
              Continue with the simulation
            </button>
          </>
        ) : !status.available ? (
          <ErrorNote>{status.reason ?? "Solana deposits are not available on this bridge."}</ErrorNote>
        ) : (
          <>
            <p className="text-dim text-body">Connect a Solana wallet on devnet. It signs one CCTP burn; the bridge builds it and never holds your keys.</p>
            {wallets.usable.length === 0 ? (
              <ErrorNote>
                {wallets.unusable.length > 0
                  ? `${wallets.unusable.join(", ")} found, but it cannot sign and send on Solana devnet. Use a wallet that can, then reload.`
                  : "No Solana wallet was found. Install one that supports devnet, then reload this page."}
              </ErrorNote>
            ) : (
              <ul className="space-y-2">
                {wallets.usable.map((entry) => (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className="border-line hover:border-line-strong text-ink-strong flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-body disabled:opacity-40"
                      disabled={phase !== "idle"}
                      onClick={() => void connect(entry)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={entry.icon} alt="" className="size-5 rounded" />
                      {entry.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        )}
      </div>
    );
  }

  if (!reviewing) {
    return (
      <div className="space-y-4">
        <Steps current={1} />
        {account && <p className="text-faint tnum break-all text-label">Wallet {account.address}</p>}
        <AmountField value={amountText} onChange={setAmountText} error={amountError} />
        {local ? (
          <p className="text-faint text-label">The simulated deposit is credited to the bridge&apos;s local test account.</p>
        ) : (
          <div>
            <label htmlFor="deposit-beneficiary" className="text-faint text-label uppercase tracking-[0.12em]">
              Arc address that receives the vault position
            </label>
            <input
              id="deposit-beneficiary"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x"
              value={beneficiary}
              onChange={(event) => setBeneficiary(event.target.value)}
              aria-invalid={beneficiaryError ? true : undefined}
              className="border-line focus:border-line-strong bg-base text-ink-strong tnum mt-2 w-full rounded-lg border px-3 py-2.5 text-body outline-none"
            />
            {beneficiaryError && <p className="text-danger mt-2 text-label">{beneficiaryError}</p>}
          </div>
        )}
        <button type="button" className={primaryButton} disabled={!canReview} onClick={() => setReviewing(true)}>
          Review
        </button>
      </div>
    );
  }

  const units = parsed.ok ? parsed.units : 0n;
  const working = phase !== "idle";
  return (
    <div className="space-y-4">
      <Steps current={2} />
      <Summary
        rows={[
          { term: local ? "Mode" : "From", value: local ? "Local simulation" : (account?.address ?? "") },
          { term: "Burn", value: `${formatUsdc(units.toString())} USDC` },
          ...(local ? [] : [{ term: "Credited to", value: beneficiary.trim() }]),
          { term: "Route", value: "Solana to Arc via CCTP, then the vault" },
          { term: "Pricing", value: "Next close" },
        ]}
      />
      {phase === "preparing" && <Notice>Asking the bridge to build the burn.</Notice>}
      {phase === "signing" && <Notice>Approve the burn in your wallet.</Notice>}
      {phase === "registering" && <Notice>Burn sent. Waiting for devnet to confirm it, then handing it to the bridge.</Notice>}
      {phase === "simulating" && <Notice>Starting the local simulation.</Notice>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <button type="button" className={secondaryButton} disabled={working} onClick={() => setReviewing(false)}>
          Back
        </button>
        <button type="button" className={primaryButton} disabled={working} onClick={() => void (local ? simulate() : signAndSend())}>
          {working ? "Working" : local ? "Simulate on the local chain" : "Sign and send"}
        </button>
      </div>
    </div>
  );
}
