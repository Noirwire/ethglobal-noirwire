import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { Address } from "viem";
import { erc20Abi } from "./abis.js";
import type { ForkClients } from "./chain.js";
import { USDC, WBTC } from "./fork-setup.js";

export const INVENTORY_PATH = "/v1/aqua/inventory";

export interface Inventory {
  usdc6: bigint;
  wbtcE8: bigint;
  observedAtSeconds: bigint;
}

export type InventoryReader = () => Promise<Inventory>;

export interface HandlerResult {
  status: number;
  body: Record<string, string>;
}

/** Aqua virtual balances are claims on tokens that never leave the maker wallet, so the wallet balance is the whole holding. */
export function createInventoryReader(clients: ForkClients): InventoryReader {
  return async () => {
    const block = await clients.publicClient.getBlock({ blockTag: "latest" });
    const maker = clients.address("maker");
    const read = (token: Address) =>
      clients.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [maker],
        blockNumber: block.number,
      });
    const [usdc6, wbtcE8] = await Promise.all([read(USDC), read(WBTC)]);
    return { usdc6, wbtcE8, observedAtSeconds: block.timestamp };
  };
}

export async function handleInventoryRequest(method: string, path: string, read: InventoryReader): Promise<HandlerResult> {
  if (path !== INVENTORY_PATH) return { status: 404, body: { error: "not found" } };
  if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
  try {
    const inventory = await read();
    return {
      status: 200,
      body: {
        usdc6: inventory.usdc6.toString(),
        wbtcE8: inventory.wbtcE8.toString(),
        observedAt: new Date(Number(inventory.observedAtSeconds) * 1000).toISOString(),
      },
    };
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export function createInventoryServer(read: InventoryReader): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    void handleInventoryRequest(request.method ?? "GET", path, read).then((result) => {
      response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result.body));
    });
  });
}
