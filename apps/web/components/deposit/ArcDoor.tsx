"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { AmountField, ErrorNote, Notice, primaryButton, secondaryButton, Steps, Summary } from "./ui";
import { arcChain, depositToVault, explainWalletError, readArcState, type ArcState, type DepositStep } from "@/lib/deposit/arc";
import { parseArcConfig, readPublicEnv } from "@/lib/deposit/config";
import { injectedProvider, requestAccounts, switchToArc, walletChainId, type Eip1193Provider } from "@/lib/deposit/evm-wallet";
import { parseUsdcAmount } from "@/lib/deposit/amount";
import { shortHash } from "@/lib/explorers";
import { formatUnits, formatUsdc } from "@/lib/format";

const configResult = parseArcConfig(readPublicEnv());

export function ArcDoor() {
  if (!configResult.ok) return <ErrorNote>{configResult.reason}. Set it and rebuild the page.</ErrorNote>;
  return <ArcFlow config={configResult.config} />;
}

type Config = Extract<typeof configResult, { ok: true }>["config"];

function ArcFlow({ config }: { config: Config }) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [state, setState] = useState<ArcState | null>(null);
  const [amountText, setAmountText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<DepositStep | "connecting" | "switching" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ depositTx: Hex; approveTx: Hex | null } | null>(null);

  const publicClient = useMemo(() => createPublicClient({ chain: arcChain(config), transport: http(config.rpcUrl) }), [config]);
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
      setState(await readArcState(publicClient, config, account));
    } catch {
      setError(`Could not read the vault on ${config.chainName}. Check that the RPC ${config.rpcUrl} is reachable, then reconnect.`);
    }
  }, [account, config, publicClient]);

  useEffect(() => {
    if (onArc) void refresh();
  }, [onArc, refresh]);

  const connect = async () => {
    if (!provider) return;
    setError(null);
    setBusy("connecting");
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
    setBusy("switching");
    try {
      await switchToArc(provider, config);
      setChainId(await walletChainId(provider));
    } catch (cause) {
      setError(explainWalletError(cause));
    } finally {
      setBusy(null);
    }
  };

  const parsed = parseUsdcAmount(amountText);
  const amountError =
    amountText.trim() === "" ? null : !parsed.ok ? parsed.reason : state && parsed.units > state.balance ? `Your wallet holds ${formatUsdc(state.balance.toString())} USDC. Enter less or add USDC.` : null;
  const blocked = state?.paused
    ? "The vault has paused new requests after a large price move. Try again after the next close."
    : state?.stalled
      ? "The vault has not closed an epoch recently, so new deposits are halted until it does."
      : null;

  const submit = async () => {
    if (!provider || !account || !parsed.ok) return;
    setError(null);
    try {
      const walletClient = createWalletClient({ account, chain: arcChain(config), transport: custom(provider) });
      const result = await depositToVault({
        publicClient,
        walletClient,
        config,
        account,
        assets: parsed.units,
        onStep: (step) => setBusy(step),
      });
      setState(result.state);
      setDone({ depositTx: result.depositTx, approveTx: result.approveTx });
    } catch (cause) {
      setError(explainWalletError(cause));
    } finally {
      setBusy(null);
    }
  };

  const txLink = (hash: Hex) =>
    config.explorer ? (
      <a href={`${config.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        {shortHash(hash)}
      </a>
    ) : (
      <span title={hash}>{shortHash(hash)}</span>
    );

  if (done && state) {
    return (
      <div className="space-y-4">
        <Steps current={2} />
        <Notice>Deposit requested. Shares are priced at the next close, not at today&apos;s price.</Notice>
        <Summary
          rows={[
            { term: "Pending request", value: `${formatUsdc(state.request.assets.toString())} USDC` },
            { term: "Priced at", value: `Close of epoch ${state.request.epoch.toString()}` },
            ...(state.claimableShares > 0n ? [{ term: "Shares ready to claim", value: formatUnits(state.claimableShares.toString(), 18, 4) }] : []),
            { term: "Credited to", value: account },
            ...(done.approveTx ? [{ term: "Approval", value: txLink(done.approveTx) }] : []),
            { term: "Deposit", value: txLink(done.depositTx) },
          ]}
        />
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            setDone(null);
            setReviewing(false);
            setAmountText("");
          }}
        >
          Deposit more
        </button>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="space-y-4">
        <Steps current={0} />
        <ErrorNote>No browser wallet was found. Install an EVM wallet extension, then reload this page.</ErrorNote>
      </div>
    );
  }

  if (!onArc) {
    return (
      <div className="space-y-4">
        <Steps current={0} />
        <p className="text-dim text-body">
          Connect an EVM wallet on {config.chainName}. Your wallet signs the approval and the deposit request directly; nothing goes through a server.
        </p>
        {account && chainId !== config.chainId && (
          <Notice>
            Your wallet is on chain {chainId}. {config.chainName} is chain {config.chainId}.
          </Notice>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        {!account ? (
          <button type="button" className={primaryButton} onClick={() => void connect()} disabled={busy !== null}>
            {busy === "connecting" ? "Waiting for wallet" : "Connect wallet"}
          </button>
        ) : (
          <button type="button" className={primaryButton} onClick={() => void switchNetwork()} disabled={busy !== null}>
            {busy === "switching" ? "Waiting for wallet" : `Switch to ${config.chainName}`}
          </button>
        )}
      </div>
    );
  }

  if (!reviewing) {
    return (
      <div className="space-y-4">
        <Steps current={1} />
        <AmountField
          value={amountText}
          onChange={setAmountText}
          error={amountError}
          hint={state ? `Wallet balance ${formatUsdc(state.balance.toString())} USDC` : "Reading your balance"}
          onMax={state ? () => setAmountText(formatUsdc(state.balance.toString(), 6).replace(/,/g, "")) : undefined}
        />
        <p className="text-faint text-label">Shares are priced at the next close, so the number of shares is not known until then.</p>
        {blocked && <ErrorNote>{blocked}</ErrorNote>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="button" className={primaryButton} disabled={!parsed.ok || amountError !== null || blocked !== null} onClick={() => setReviewing(true)}>
          Review
        </button>
      </div>
    );
  }

  const units = parsed.ok ? parsed.units : 0n;
  const needsApproval = state ? state.allowance < units : true;
  return (
    <div className="space-y-4">
      <Steps current={2} />
      <Summary
        rows={[
          { term: "Deposit", value: `${formatUsdc(units.toString())} USDC` },
          { term: "Credited to", value: account },
          { term: "Pricing", value: "Next close" },
          { term: "Approval", value: needsApproval ? "Needed first (2 wallet prompts)" : "Already sufficient" },
        ]}
      />
      {busy === "approving" && <Notice>Approving USDC. Confirm in your wallet, then wait for it to be mined.</Notice>}
      {busy === "depositing" && <Notice>Requesting the deposit. Confirm in your wallet, then wait for it to be mined.</Notice>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => setReviewing(false)}>
          Back
        </button>
        <button type="button" className={primaryButton} disabled={busy !== null || !parsed.ok} onClick={() => void submit()}>
          {busy ? "Working" : needsApproval ? "Approve and deposit" : "Deposit"}
        </button>
      </div>
    </div>
  );
}
