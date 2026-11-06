import { LOCAL_NETWORKS } from "@noirwire/shared";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type TestClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { hedgeGuardAbi } from "./abis.js";
import { type HedgeTarget, toDirectionCode } from "./band.js";

export const DEFAULT_FORK_RPC = LOCAL_NETWORKS.aquaFork.rpcUrl;

/** Public anvil test keys. They exist only on throwaway local forks and must never hold real value. */
export const ANVIL_DEFAULT_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  hedger: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  maker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdb9aa0a",
  taker: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

export type ForkRole = keyof typeof ANVIL_DEFAULT_KEYS;

export interface ForkClients {
  rpcUrl: string;
  publicClient: PublicClient<HttpTransport, Chain>;
  testClient: TestClient<"anvil", HttpTransport, Chain>;
  wallet(role: ForkRole): WalletClient<HttpTransport, Chain, Account>;
  address(role: ForkRole): Address;
}

export async function readHedgeTarget(clients: ForkClients, hedgeGuard: Address, maker: Address): Promise<HedgeTarget> {
  const target = await clients.publicClient.readContract({
    address: hedgeGuard,
    abi: hedgeGuardAbi,
    functionName: "targetOf",
    args: [maker],
  });
  return {
    direction: toDirectionCode(target.direction),
    remaining: target.remaining,
    minPriceE8: target.minPriceE8,
    maxPriceE8: target.maxPriceE8,
    expiry: BigInt(target.expiry),
  };
}

export function createForkClients(rpcUrl: string = DEFAULT_FORK_RPC): ForkClients {
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arbitrum, transport });
  const testClient = createTestClient({ chain: arbitrum, transport, mode: "anvil" });
  const accounts = {
    deployer: privateKeyToAccount(ANVIL_DEFAULT_KEYS.deployer),
    hedger: privateKeyToAccount(ANVIL_DEFAULT_KEYS.hedger),
    maker: privateKeyToAccount(ANVIL_DEFAULT_KEYS.maker),
    taker: privateKeyToAccount(ANVIL_DEFAULT_KEYS.taker),
  };
  return {
    rpcUrl,
    publicClient,
    testClient,
    wallet: (role) => createWalletClient({ account: accounts[role], chain: arbitrum, transport }),
    address: (role) => accounts[role].address,
  };
}
