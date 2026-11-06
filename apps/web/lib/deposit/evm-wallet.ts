import { EVM_FUNDING_SOURCES, type EvmFundingSourceId } from "@noirwire/shared";
import { getAddress, numberToHex, type Address } from "viem";
import { ARC_NATIVE_CURRENCY, type ArcConfig } from "./config";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
}

export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export async function requestAccounts(provider: Eip1193Provider): Promise<Address> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("The wallet returned no account. Unlock it and try again.");
  return getAddress(first);
}

export async function walletChainId(provider: Eip1193Provider): Promise<number> {
  return Number(await provider.request({ method: "eth_chainId" }));
}

export async function switchToSource(provider: Eip1193Provider, id: EvmFundingSourceId): Promise<void> {
  const source = EVM_FUNDING_SOURCES[id];
  const chainId = numberToHex(source.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: source.label,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [source.rpcUrl],
          blockExplorerUrls: [source.explorer],
        },
      ],
    });
  }
}

export async function switchToArc(provider: Eip1193Provider, config: ArcConfig): Promise<void> {
  const chainId = numberToHex(config.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: config.chainName,
          nativeCurrency: ARC_NATIVE_CURRENCY,
          rpcUrls: [config.rpcUrl],
          ...(config.explorer ? { blockExplorerUrls: [config.explorer] } : {}),
        },
      ],
    });
  }
}
