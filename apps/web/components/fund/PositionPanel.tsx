"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { Timeline } from "../deposit/Timeline";
import { ErrorNote, Notice, primaryButton, secondaryButton, Summary } from "../deposit/ui";
import { Label } from "../parts";
import { arcChain, explainWalletError } from "@/lib/deposit/arc";
import { parseArcConfig, readPublicEnv, type ArcConfig } from "@/lib/deposit/config";
import { injectedProvider, requestAccounts, switchToArc, walletChainId, type Eip1193Provider } from "@/lib/deposit/evm-wallet";
import {
  claimHeldDeposit,
  lockupRemainingSeconds,
  parseShareAmount,
  readPosition,
  runWithdrawAction,
  shareValueUsdc,
  withdrawStage,
  withdrawStepStatuses,
  type Position,
  type WithdrawAction,
} from "@/lib/deposit/position";
import { shortHash } from "@/lib/explorers";
import { formatSharePrice, formatUnits, formatUsdc } from "@/lib/format";

const configResult = parseArcConfig(readPublicEnv());
const REFRESH_MS = 15000;

export function PositionPanel() {
  if (!configResult.ok) return <ErrorNote>{configResult.reason}. Set it and rebuild the page.</ErrorNote>;
  return <Panel config={configResult.config} />;
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} hours`;
  return `${Math.max(1, Math.ceil(seconds / 60))} minutes`;
}

function Panel({ config }: { config: ArcConfig }) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [sharesText, setSharesText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hex | null>(null);

  const client = useMemo(() => createPublicClient({ chain: arcChain(config), transport: http(config.rpcUrl) }), [config]);
  const onArc = account !== null && chainId === config.chainId;

  useEffect(() => {
    const found = injectedProvider();
    if (!found) return;
    setProvider(found);
    const onAccounts = (accounts: string[]) => setAccount((accounts[0] as Address | undefined) ?? null);
    const onChain = (hex: string) => setChainId(Number(hex));
    found.on?.("accountsChanged", onAccounts as never);
    found.on?.("chainChanged", onChain as never);
    return () => {
      found.removeListener?.("accountsChanged", onAccounts as never);
      found.removeListener?.("chainChanged", onChain as never);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      setPosition(await readPosition(client, config, account));
    } catch {
      setError(`Could not read the vault on ${config.chainName}. Check that the RPC ${config.rpcUrl} is reachable.`);
    }
  }, [account, client, config]);

  useEffect(() => {
    if (!onArc) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [onArc, refresh]);

  const wallet = async (label: string, work: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error && !("shortMessage" in cause) && !("code" in cause) ? cause.message : explainWalletError(cause));
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    wallet("Waiting for wallet", async () => {
      if (!provider) return;
      setAccount(await requestAccounts(provider));
      setChainId(await walletChainId(provider));
    });

  const switchNetwork = () =>
    wallet("Waiting for wallet", async () => {
      if (!provider) return;
      await switchToArc(provider, config);
      setChainId(await walletChainId(provider));
    });

  const act = (action: WithdrawAction, label: string, shares?: bigint) =>
    wallet(label, async () => {
      if (!provider || !account) return;
      const walletClient = createWalletClient({ account, chain: arcChain(config), transport: custom(provider) });
      const hash = await runWithdrawAction({ publicClient: client, walletClient, config, account, action, shares, onSent: setLastTx });
      setLastTx(hash);
      if (action === "request") setSharesText("");
      await refresh();
    });

  const claimHeld = () =>
    wallet("Claiming held USDC", async () => {
      if (!provider || !account) return;
      const walletClient = createWalletClient({ account, chain: arcChain(config), transport: custom(provider) });
      setLastTx(await claimHeldDeposit({ publicClient: client, walletClient, config, account }));
      await refresh();
    });

  const shell = (children: React.ReactNode) => (
    <section aria-labelledby="position-title" className="border-line rounded-xl border p-5">
      <h2 id="position-title" className="text-ink-strong text-[18px] font-semibold tracking-tight">
        My position
      </h2>
      <p className="text-faint mt-1 text-label">Test network. Shares of the maker vault held by your connected wallet.</p>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );

  if (!provider) return shell(<ErrorNote>No browser wallet was found. Install an EVM wallet extension, then reload this page.</ErrorNote>);

  if (!onArc) {
    return shell(
      <>
        {account && (
          <Notice>
            Your wallet is on chain {chainId}. {config.chainName} is chain {config.chainId}.
          </Notice>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => void (account ? switchNetwork() : connect())}>
          {busy ?? (account ? `Switch to ${config.chainName}` : "Connect wallet")}
        </button>
      </>,
    );
  }

  if (!position) return shell(<p className="text-faint text-body">{error ?? "Reading your position"}</p>);

  const stage = withdrawStage(position);
  const hasPrice = position.lastPrice > 0n;
  const value = hasPrice ? `${formatUsdc(shareValueUsdc(position.shares, position.lastPrice).toString())} USDC` : "No close yet";
  const lock = lockupRemainingSeconds(position.lockedUntil, Math.floor(Date.now() / 1000));
  const parsedShares = parseShareAmount(sharesText, position.shares);
  const sharesError = sharesText.trim() === "" || parsedShares.ok ? null : parsedShares.reason;
  const statuses = withdrawStepStatuses(stage);
  const working = busy !== null;

  return shell(
    <>
      <Summary
        rows={[
          { term: "Wallet", value: account },
          { term: "Shares held", value: formatUnits(position.shares.toString(), 18, 4) },
          { term: "Value at last close", value: value },
          { term: "Last close price", value: hasPrice ? `${formatSharePrice(position.lastPrice.toString())} USD per share` : "None yet" },
          ...(position.deposit.assets > 0n && position.deposit.epoch >= position.currentEpoch
            ? [{ term: "Pending deposit", value: `${formatUsdc(position.deposit.assets.toString())} USDC, priced at the next close` }]
            : []),
          ...(position.claimableShares > 0n ? [{ term: "Shares ready to claim", value: formatUnits(position.claimableShares.toString(), 18, 4) }] : []),
          ...(position.heldByHook > 0n ? [{ term: "USDC held, not deposited", value: `${formatUsdc(position.heldByHook.toString())} USDC` }] : []),
        ]}
      />
      {position.claimableShares > 0n && (
        <button type="button" className={primaryButton} disabled={working} onClick={() => void act("claim-shares", "Claiming shares")}>
          {busy === "Claiming shares" ? "Working" : "Claim shares"}
        </button>
      )}
      {position.heldByHook > 0n && (
        <>
          <Notice>This deposit arrived after its deadline or the vault refused it, so the USDC waits for you instead of being lost.</Notice>
          <button type="button" className={secondaryButton} disabled={working} onClick={() => void claimHeld()}>
            {busy === "Claiming held USDC" ? "Working" : "Claim held USDC"}
          </button>
        </>
      )}

      <div className="border-line-subtle space-y-4 border-t pt-4">
        <Label>Withdraw</Label>
        <Timeline
          rows={[
            { key: "request", label: "Request withdrawal", status: statuses[0], detail: stage === "none" ? null : { href: null, text: `${formatUnits(position.redeem.shares.toString(), 18, 4)} shares` } },
            { key: "close", label: "Next close prices it", status: statuses[1], detail: stage === "waiting-for-close" ? { href: null, text: `Epoch ${position.currentEpoch.toString()}` } : null },
            { key: "claim", label: "Claim USDC", status: statuses[2], detail: position.claimableAssets > 0n ? { href: null, text: `${formatUsdc(position.claimableAssets.toString())} USDC` } : null },
          ]}
        />
        {stage === "none" || stage === "partly-carried" || stage === "waiting-for-close" ? (
          <div>
            <label htmlFor="withdraw-shares" className="text-faint text-label uppercase tracking-[0.12em]">
              Shares to withdraw
            </label>
            <div className="border-line focus-within:border-line-strong bg-base mt-2 flex items-center rounded-lg border">
              <input
                id="withdraw-shares"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={sharesText}
                onChange={(event) => setSharesText(event.target.value)}
                aria-invalid={sharesError ? true : undefined}
                aria-describedby="withdraw-shares-note"
                className="tnum text-ink-strong min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[18px] outline-none"
              />
              <button type="button" onClick={() => setSharesText(formatUnits(position.shares.toString(), 18, 18).replace(/,/g, ""))} className="text-dim hover:text-ink-strong px-3 text-label">
                Max
              </button>
            </div>
            <p id="withdraw-shares-note" className={`mt-2 text-label ${sharesError ? "text-danger" : "text-faint"}`}>
              {sharesError ?? "Withdrawals are priced at the next close. The vault may fill only part of a request; the rest carries to the following close."}
            </p>
          </div>
        ) : null}
        {lock > 0 && <Notice>New deposits are locked for another {formatDuration(lock)}. You can request a withdrawal after that.</Notice>}
        {position.paused && <Notice>The vault has paused new requests after a large price move. Try again after the next close.</Notice>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex flex-wrap gap-2">
          {stage === "none" || stage === "partly-carried" || stage === "waiting-for-close" ? (
            <button
              type="button"
              className={primaryButton}
              disabled={working || !parsedShares.ok || lock > 0 || position.paused}
              onClick={() => parsedShares.ok && void act("request", "Requesting withdrawal", parsedShares.units)}
            >
              {busy === "Requesting withdrawal" ? "Working" : "Request withdrawal"}
            </button>
          ) : null}
          {position.claimableAssets > 0n && (
            <button type="button" className={primaryButton} disabled={working} onClick={() => void act("claim-assets", "Claiming USDC")}>
              {busy === "Claiming USDC" ? "Working" : "Claim USDC"}
            </button>
          )}
          {position.redeem.shares > 0n && (
            <button type="button" className={secondaryButton} disabled={working} onClick={() => void act("cancel", "Cancelling request")}>
              {busy === "Cancelling request" ? "Working" : "Cancel request"}
            </button>
          )}
        </div>
        {busy && <Notice>{busy}. Confirm in your wallet, then wait for it to be mined.</Notice>}
        {lastTx && (
          <p className="text-faint text-label">
            Last transaction{" "}
            {config.explorer ? (
              <a href={`${config.explorer}/tx/${lastTx}`} target="_blank" rel="noreferrer" className="tnum text-dim hover:text-ink-strong underline underline-offset-2">
                {shortHash(lastTx)}
              </a>
            ) : (
              <span className="tnum">{shortHash(lastTx)}</span>
            )}
          </p>
        )}
      </div>
    </>,
  );
}
