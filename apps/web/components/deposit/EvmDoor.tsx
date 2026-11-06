"use client";

import { EVM_FUNDING_SOURCES, type EvmFundingSourceId } from "@noirwire/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { AmountField, ErrorNote, Notice, primaryButton, secondaryButton, Summary } from "./ui";
import { Timeline, type TimelineRow } from "./Timeline";
import { arcChain, erc20Abi, explainWalletError } from "@/lib/deposit/arc";
import { fetchAttestation, fetchEvmFee, fetchEvmStatus, submitEvmBurn, type EvmStatus } from "@/lib/deposit/api";
import { parseArcConfig, readPublicEnv, type ArcConfig } from "@/lib/deposit/config";
import {
  burnArguments,
  fastFeeBps,
  FUNDING_STEP_LABEL,
  FUNDING_STEPS,
  hookExecutorAbi,
  maxFeeFor,
  messageNonce,
  SOURCE_IDS,
  sourceChain,
  sourceTxUrl,
  stepStatuses,
  tokenMessengerAbi,
  tokenMessengerAddress,
  type FundingProgress,
} from "@/lib/deposit/evm-source";
import { injectedProvider, requestAccounts, switchToSource, walletChainId, type Eip1193Provider } from "@/lib/deposit/evm-wallet";
import { parseUsdcAmount } from "@/lib/deposit/amount";
import { readPosition } from "@/lib/deposit/position";
import { shortHash } from "@/lib/explorers";
import { formatUsdc } from "@/lib/format";

const configResult = parseArcConfig(readPublicEnv());
const ATTESTATION_POLL_MS = 5000;
const DELIVERY_POLL_MS = 6000;
const SHARES_POLL_MS = 10000;
const BRIDGE_REGISTER_ATTEMPTS = 6;
const BRIDGE_REGISTER_WAIT_MS = 3000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function EvmDoor() {
  const [status, setStatus] = useState<EvmStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchEvmStatus().then((result) => {
      if (cancelled) return;
      if (result.ok) setStatus(result.data);
      else setStatusError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!configResult.ok) return <ErrorNote>{configResult.reason}. Set it and rebuild the page.</ErrorNote>;
  if (!configResult.config.hookExecutor) {
    return <ErrorNote>Funding from Ethereum networks is not configured: NEXT_PUBLIC_HOOK_EXECUTOR_ADDRESS is not set. Set it and rebuild the page.</ErrorNote>;
  }
  if (statusError) return <ErrorNote>{statusError}</ErrorNote>;
  if (!status) return <p className="text-faint text-body">Checking the bridge</p>;
  return <EvmFlow config={configResult.config} hookExecutor={configResult.config.hookExecutor} status={status} />;
}

function usePoll(enabled: boolean, run: () => Promise<boolean>, intervalMs: number) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let finished = false;
      try {
        finished = await latest.current();
      } catch {
        finished = false;
      }
      if (!cancelled && !finished) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
}

const EMPTY_PROGRESS: FundingProgress = { needsApproval: true, approveTx: null, burnTx: null, attested: false, delivered: false, sharesReady: false };

function EvmFlow({ config, hookExecutor, status }: { config: ArcConfig; hookExecutor: Address; status: EvmStatus }) {
  const [sourceId, setSourceId] = useState<EvmFundingSourceId>("ethereumSepolia");
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [amountText, setAmountText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FundingProgress | null>(null);
  const [message, setMessage] = useState<Hex | null>(null);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const baselineShares = useRef<bigint | null>(null);

  const source = EVM_FUNDING_SOURCES[sourceId];
  const onSource = account !== null && chainId === source.chainId;
  const sourceClient = useMemo(() => createPublicClient({ chain: sourceChain(sourceId), transport: http(source.rpcUrl) }), [sourceId, source.rpcUrl]);
  const arcClient = useMemo(() => createPublicClient({ chain: arcChain(config), transport: http(config.rpcUrl) }), [config]);
  const usdc = source.usdc as Address;

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

  const refreshSource = useCallback(async () => {
    if (!account) return;
    try {
      const [held, allowed] = await Promise.all([
        sourceClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        sourceClient.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account, tokenMessengerAddress] }),
      ]);
      setBalance(held);
      setAllowance(allowed);
    } catch {
      setBalance(null);
      setError(`Could not read your USDC on ${source.label}. Check your connection and reconnect.`);
    }
  }, [account, sourceClient, usdc, source.label]);

  useEffect(() => {
    setBalance(null);
    if (onSource) void refreshSource();
  }, [onSource, refreshSource]);

  const connect = async () => {
    if (!provider) return;
    setError(null);
    setBusy("Waiting for wallet");
    try {
      setAccount(await requestAccounts(provider));
      setChainId(await walletChainId(provider));
    } catch (cause) {
      setError(explainWalletError(cause));
    } finally {
      setBusy(null);
    }
  };

  const switchNetwork = async () => {
    if (!provider) return;
    setError(null);
    setBusy("Waiting for wallet");
    try {
      await switchToSource(provider, sourceId);
      setChainId(await walletChainId(provider));
    } catch (cause) {
      setError(explainWalletError(cause));
    } finally {
      setBusy(null);
    }
  };

  const parsed = parseUsdcAmount(amountText);
  const amountError =
    amountText.trim() === "" ? null : !parsed.ok ? parsed.reason : balance !== null && parsed.units > balance ? `Your wallet holds ${formatUsdc(balance.toString())} USDC on ${source.label}. Enter less or add USDC.` : null;

  const start = async () => {
    if (!provider || !account || !parsed.ok) return;
    const amount = parsed.units;
    setError(null);
    baselineShares.current = null;
    const needsApproval = allowance < amount;
    let next: FundingProgress = { ...EMPTY_PROGRESS, needsApproval };
    setProgress(next);
    const walletClient = createWalletClient({ account, chain: sourceChain(sourceId), transport: custom(provider) });
    try {
      if (needsApproval) {
        setBusy("Approve USDC in your wallet");
        const approveTx = await walletClient.writeContract({
          account,
          chain: sourceChain(sourceId),
          address: usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [tokenMessengerAddress, amount],
        });
        next = { ...next, approveTx };
        setProgress(next);
        setBusy("Waiting for the approval to be mined");
        const approved = await sourceClient.waitForTransactionReceipt({ hash: approveTx });
        if (approved.status !== "success") throw new Error(`The USDC approval was mined but reverted (${approveTx}).`);
      }

      setBusy("Asking Circle for the current fee");
      const fee = await fetchEvmFee(source.cctpDomain);
      if (!fee.ok) throw new Error(fee.error);
      const bps = fastFeeBps(fee.data.tiers);
      if (bps === null) throw new Error("Circle quotes no fast transfer fee for this route right now. Try again shortly.");
      const args = burnArguments({ amount, source: sourceId, account, hookExecutor, maxFee: maxFeeFor(amount, bps), now: Date.now() });

      setBusy("Send the USDC in your wallet");
      const { request } = await sourceClient.simulateContract({ account, address: tokenMessengerAddress, abi: tokenMessengerAbi, functionName: "depositForBurnWithHook", args });
      const burnTx = await walletClient.writeContract({ ...request, account, chain: sourceChain(sourceId) });
      next = { ...next, burnTx };
      setProgress(next);
      setBusy("Waiting for the burn to be mined");
      const burned = await sourceClient.waitForTransactionReceipt({ hash: burnTx });
      if (burned.status !== "success") throw new Error(`The burn was mined but reverted (${burnTx}).`);
      setBusy(null);
      void refreshSource();
      void handToBridge(burnTx);
    } catch (cause) {
      setBusy(null);
      setError(cause instanceof Error && !("shortMessage" in cause) && !("code" in cause) ? cause.message : explainWalletError(cause));
    }
  };

  const handToBridge = async (burnTx: Hex) => {
    for (let attempt = 0; attempt < BRIDGE_REGISTER_ATTEMPTS; attempt++) {
      const result = await submitEvmBurn(source.cctpDomain, burnTx);
      if (result.ok) return setBridgeNote(null);
      if (result.status !== 404) {
        return setBridgeNote(`The burn is on chain (${shortHash(burnTx)}) but the bridge did not accept it: ${result.error}`);
      }
      await sleep(BRIDGE_REGISTER_WAIT_MS);
    }
    setBridgeNote(`The burn is on chain (${shortHash(burnTx)}) but the bridge has not picked it up yet. It is not lost; keep the transaction link.`);
  };

  const burnTx = progress?.burnTx ?? null;
  const attested = progress?.attested ?? false;
  const delivered = progress?.delivered ?? false;
  const sharesReady = progress?.sharesReady ?? false;

  usePoll(burnTx !== null && !attested, async () => {
    if (!burnTx) return true;
    const result = await fetchAttestation(source.cctpDomain, burnTx);
    if (!result.ok || result.data.state !== "complete") return false;
    setMessage(result.data.message);
    setProgress((current) => (current ? { ...current, attested: true } : current));
    return true;
  }, ATTESTATION_POLL_MS);

  usePoll(attested && !delivered && message !== null, async () => {
    if (!message) return true;
    const done = await arcClient.readContract({ address: hookExecutor, abi: hookExecutorAbi, functionName: "processed", args: [messageNonce(message)] });
    if (!done) return false;
    setProgress((current) => (current ? { ...current, delivered: true } : current));
    return true;
  }, DELIVERY_POLL_MS);

  usePoll(delivered && !sharesReady && account !== null, async () => {
    if (!account) return true;
    const position = await readPosition(arcClient, config, account);
    baselineShares.current ??= position.shares;
    if (position.claimableShares > 0n || position.shares > baselineShares.current) {
      setProgress((current) => (current ? { ...current, sharesReady: true } : current));
      return true;
    }
    return false;
  }, SHARES_POLL_MS);

  const reset = () => {
    setProgress(null);
    setMessage(null);
    setBridgeNote(null);
    setReviewing(false);
    setAmountText("");
    setError(null);
  };

  if (progress) {
    const statuses = stepStatuses(progress);
    const rows: TimelineRow[] = FUNDING_STEPS.map((step) => ({
      key: step,
      label: FUNDING_STEP_LABEL[step],
      status: statuses[step],
      detail: stepDetail(step, progress, sourceId, config),
    }));
    return (
      <div className="space-y-4">
        <Timeline rows={rows} />
        {busy && <Notice>{busy}.</Notice>}
        {bridgeNote && <ErrorNote>{bridgeNote}</ErrorNote>}
        {error && <ErrorNote>{error}</ErrorNote>}
        {burnTx && !delivered && (
          <Notice>
            {status.available
              ? "The bridge delivers your deposit to the vault once Circle has attested the burn. You can leave this page; your position panel shows the result."
              : "Waiting for delivery."}
          </Notice>
        )}
        {delivered && <Notice>Delivered. The deposit is a pending request in the vault and is priced at the next close.</Notice>}
        <button type="button" className={secondaryButton} disabled={busy !== null} onClick={reset}>
          {burnTx ? "Fund more" : "Back"}
        </button>
      </div>
    );
  }

  if (!provider) {
    return <ErrorNote>No browser wallet was found. Install an EVM wallet extension, then reload this page.</ErrorNote>;
  }

  return (
    <div className="space-y-4">
      {!status.available && <ErrorNote>{status.reason ?? "Funding from Ethereum networks is not available on this bridge."}</ErrorNote>}
      <fieldset>
        <legend className="text-faint text-label uppercase tracking-[0.12em]">Fund from</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {SOURCE_IDS.map((id) => (
            <label
              key={id}
              className={`inline-flex min-h-10 cursor-pointer items-center rounded-full border px-4 text-body ${
                id === sourceId ? "border-ink-strong text-ink-strong" : "border-line text-dim hover:text-ink-strong"
              }`}
            >
              <input type="radio" name="funding-source" className="sr-only" checked={id === sourceId} onChange={() => { setSourceId(id); setReviewing(false); }} />
              {EVM_FUNDING_SOURCES[id].label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-dim text-body">
        Test USDC on {source.label} is burned through Circle CCTP and minted on Arc Testnet straight into the vault for your address. Your wallet signs; no keys leave it.
      </p>
      {!account ? (
        <button type="button" className={primaryButton} onClick={() => void connect()} disabled={busy !== null}>
          {busy ?? "Connect wallet"}
        </button>
      ) : !onSource ? (
        <>
          <Notice>
            Your wallet is on chain {chainId}. {source.label} is chain {source.chainId}.
          </Notice>
          <button type="button" className={primaryButton} onClick={() => void switchNetwork()} disabled={busy !== null}>
            {busy ?? `Switch to ${source.label}`}
          </button>
        </>
      ) : !reviewing ? (
        <>
          <AmountField
            value={amountText}
            onChange={setAmountText}
            error={amountError}
            hint={balance !== null ? `Wallet balance ${formatUsdc(balance.toString())} USDC on ${source.label}` : "Reading your balance"}
            onMax={balance !== null ? () => setAmountText(formatUsdc(balance.toString(), 6).replace(/,/g, "")) : undefined}
          />
          <p className="text-faint text-label">You also need a little {source.label} ETH for gas. Shares are priced at the next close.</p>
          <button type="button" className={primaryButton} disabled={!parsed.ok || amountError !== null || !status.available} onClick={() => setReviewing(true)}>
            Review
          </button>
        </>
      ) : (
        <>
          <Summary
            rows={[
              { term: "From", value: `${source.label}, ${account}` },
              { term: "Burn", value: `${formatUsdc((parsed.ok ? parsed.units : 0n).toString())} USDC` },
              { term: "Credited to", value: account },
              { term: "Route", value: `${source.label} to Arc via CCTP, then the vault` },
              { term: "Approval", value: allowance < (parsed.ok ? parsed.units : 0n) ? "Needed first (2 wallet prompts)" : "Already sufficient" },
              { term: "Pricing", value: "Next close" },
            ]}
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={() => setReviewing(false)}>
              Back
            </button>
            <button type="button" className={primaryButton} disabled={busy !== null || !parsed.ok} onClick={() => void start()}>
              {busy ? "Working" : "Approve and send"}
            </button>
          </div>
        </>
      )}
      {!reviewing && error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function stepDetail(step: (typeof FUNDING_STEPS)[number], progress: FundingProgress, sourceId: EvmFundingSourceId, config: ArcConfig): TimelineRow["detail"] {
  const link = (href: string, hash: string) => ({ href, text: shortHash(hash) });
  switch (step) {
    case "approve":
      return progress.approveTx ? link(sourceTxUrl(sourceId, progress.approveTx), progress.approveTx) : progress.needsApproval ? null : { href: null, text: "Already approved" };
    case "burn":
      return progress.burnTx ? link(sourceTxUrl(sourceId, progress.burnTx), progress.burnTx) : null;
    case "attestation":
      return progress.attested ? { href: null, text: "Signed by Circle" } : null;
    case "delivered":
      return progress.delivered && config.hookExecutor ? { href: config.explorer ? `${config.explorer}/address/${config.hookExecutor}` : null, text: "Hook executor on Arc" } : null;
    case "shares":
      return progress.sharesReady ? { href: null, text: "Shares are ready" } : progress.delivered ? { href: null, text: "Priced at the next close" } : null;
  }
}
