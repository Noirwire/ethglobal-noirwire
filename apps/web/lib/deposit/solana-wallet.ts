import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets, type Wallets } from "@wallet-standard/app";
import { base58Encode } from "./base58";

export type StandardWallet = ReturnType<Wallets["get"]>[number];
export type StandardAccount = StandardWallet["accounts"][number];

const SOLANA_DEVNET_CHAIN = "solana:devnet";
const STANDARD_CONNECT = "standard:connect";

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly StandardAccount[] }>;
}

type SignAndSend = SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction];

const featureOf = <T>(wallet: StandardWallet, name: string) => (wallet.features as Record<string, unknown>)[name] as T | undefined;

function usableWallets(wallets: readonly StandardWallet[]): StandardWallet[] {
  return wallets.filter(
    (wallet) =>
      STANDARD_CONNECT in wallet.features &&
      SolanaSignAndSendTransaction in wallet.features &&
      wallet.chains.includes(SOLANA_DEVNET_CHAIN),
  );
}

export function solanaWalletsInBrowser(): { usable: StandardWallet[]; unusable: string[] } {
  const all = getWallets().get();
  const usable = usableWallets(all);
  const unusable = all
    .filter((wallet) => !usable.includes(wallet) && wallet.chains.some((chain) => chain.startsWith("solana:")))
    .map((wallet) => wallet.name);
  return { usable, unusable };
}

export function onWalletsChanged(listener: () => void): () => void {
  const registry = getWallets();
  const off = [registry.on("register", listener), registry.on("unregister", listener)];
  return () => off.forEach((stop) => stop());
}

export async function connectSolana(wallet: StandardWallet): Promise<StandardAccount> {
  const feature = featureOf<ConnectFeature>(wallet, STANDARD_CONNECT);
  if (!feature) throw new Error(`${wallet.name} cannot connect to a page.`);
  const { accounts } = await feature.connect();
  const account = accounts[0] ?? wallet.accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account. Unlock it and try again.`);
  return account;
}

export async function signAndSendBase64(wallet: StandardWallet, account: StandardAccount, transactionBase64: string): Promise<string> {
  const feature = featureOf<SignAndSend>(wallet, SolanaSignAndSendTransaction);
  if (!feature) throw new Error(`${wallet.name} cannot sign and send transactions.`);
  const bytes = Uint8Array.from(atob(transactionBase64), (char) => char.charCodeAt(0));
  const [output] = await feature.signAndSendTransaction({ account, chain: SOLANA_DEVNET_CHAIN, transaction: bytes });
  if (!output) throw new Error("The wallet returned no signature.");
  return base58Encode(output.signature);
}

export function explainSolanaError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel|declin/i.test(text)) {
    return "You rejected the request in your wallet. Nothing was sent. Approve it in the wallet to continue.";
  }
  if (/insufficient|0x1\b|lamports/i.test(text)) {
    return "The wallet could not pay for the transaction. Add devnet SOL for fees and try again.";
  }
  return text.split("\n")[0] || "The wallet request failed.";
}
