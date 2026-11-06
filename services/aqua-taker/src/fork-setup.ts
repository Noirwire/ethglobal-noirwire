import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AQUA, ARBITRUM_TOKENS } from "@noirwire/shared";
import { type Address, type Hex, encodeAbiParameters, getAddress, isHex, keccak256, pad, toHex } from "viem";
import { z } from "zod";
import { chainlinkAbi, erc20Abi, hedgeGuardAbi, testAggregatorAbi } from "./abis.js";
import { type ForkClients } from "./chain.js";
import { type OracleMode } from "./config.js";

export const WBTC = getAddress(ARBITRUM_TOKENS.wbtc);
export const USDC = getAddress(ARBITRUM_TOKENS.usdc);
const CHAINLINK_BTC_USD = getAddress(ARBITRUM_TOKENS.chainlinkBtcUsd);

const BALANCE_SLOT_SEARCH_LIMIT = 120;
const MAX_ORACLE_AGE_SECONDS = 3600;
const MAX_ORACLE_DEVIATION_BPS = 300;
const ETH_FUNDING_WEI = 10n ** 21n;

const artifactSchema = z.object({
  bytecode: z.object({ object: z.custom<Hex>((value) => typeof value === "string" && isHex(value) && value.length > 2) }),
});

const balanceSlotIndexes = new Map<string, number>();

export interface Deployment {
  usdc: Address;
  wbtc: Address;
  router: Address;
  aqua: Address;
  hedgeGuard: Address;
  oracle: Address;
}

function artifactUrl(contract: string): URL {
  return new URL(`../../../contracts/aqua/out/${contract}.sol/${contract}.json`, import.meta.url);
}

async function loadBytecode(contract: string): Promise<Hex> {
  const raw = await readFile(fileURLToPath(artifactUrl(contract)), "utf8");
  return artifactSchema.parse(JSON.parse(raw)).bytecode.object;
}

function balanceSlotAt(holder: Address, index: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(index)]));
}

async function balanceSlotFor(
  clients: ForkClients,
  token: Address,
  holder: Address,
  probeValue: bigint,
): Promise<Hex> {
  const cachedIndex = balanceSlotIndexes.get(token.toLowerCase());
  if (cachedIndex !== undefined) return balanceSlotAt(holder, cachedIndex);
  for (let index = 0; index < BALANCE_SLOT_SEARCH_LIMIT; index++) {
    const slot = balanceSlotAt(holder, index);
    const original = await clients.publicClient.getStorageAt({ address: token, slot });
    await clients.testClient.setStorageAt({ address: token, index: slot, value: pad(toHex(probeValue), { size: 32 }) });
    const seen = await tokenBalance(clients, token, holder);
    await clients.testClient.setStorageAt({ address: token, index: slot, value: original ?? pad("0x00", { size: 32 }) });
    if (seen === probeValue) {
      balanceSlotIndexes.set(token.toLowerCase(), index);
      return slot;
    }
  }
  throw new Error(`no balance slot found for ${token} within ${BALANCE_SLOT_SEARCH_LIMIT} mapping slots`);
}

export async function setTokenBalance(
  clients: ForkClients,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<void> {
  const slot = await balanceSlotFor(clients, token, holder, amount + 1n);
  await clients.testClient.setStorageAt({ address: token, index: slot, value: pad(toHex(amount), { size: 32 }) });
}

async function assertOfficialContracts(clients: ForkClients): Promise<void> {
  for (const [label, address] of [
    ["Aqua registry", AQUA.registry],
    ["SwapVM router", AQUA.swapVmRouter],
  ] as const) {
    const code = await clients.publicClient.getCode({ address });
    if (code === undefined || code === "0x") throw new Error(`${label} has no code at ${address} on this chain`);
  }
}

async function pinTimeToFork(clients: ForkClients): Promise<void> {
  const latest = await clients.publicClient.getBlock();
  await clients.testClient.setNextBlockTimestamp({ timestamp: latest.timestamp + 1n });
  await clients.testClient.mine({ blocks: 1 });
}

async function deployedAddress(clients: ForkClients, hash: Hex, label: string): Promise<Address> {
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress == null) throw new Error(`${label} deployment returned no address`);
  return receipt.contractAddress;
}

export async function deployHedgeGuard(clients: ForkClients, oracleMode: OracleMode): Promise<Deployment> {
  await assertOfficialContracts(clients);
  const deployer = clients.wallet("deployer");

  const [, answer] = await clients.publicClient.readContract({
    address: CHAINLINK_BTC_USD,
    abi: chainlinkAbi,
    functionName: "latestRoundData",
  });

  let oracle: Address = CHAINLINK_BTC_USD;
  if (oracleMode === "test-aggregator") {
    const hash = await deployer.deployContract({
      abi: testAggregatorAbi,
      bytecode: await loadBytecode("TestAggregator"),
      args: [deployer.account.address, answer],
    });
    oracle = await deployedAddress(clients, hash, "TestAggregator");
  } else {
    await pinTimeToFork(clients);
  }

  const hash = await deployer.deployContract({
    abi: hedgeGuardAbi,
    bytecode: await loadBytecode("HedgeGuard"),
    args: [
      AQUA.swapVmRouter,
      WBTC,
      USDC,
      deployer.account.address,
      clients.address("hedger"),
      { feed: oracle, maxAge: MAX_ORACLE_AGE_SECONDS, maxDeviationBps: MAX_ORACLE_DEVIATION_BPS },
    ],
  });

  return {
    usdc: USDC,
    wbtc: WBTC,
    router: AQUA.swapVmRouter,
    aqua: AQUA.registry,
    hedgeGuard: await deployedAddress(clients, hash, "HedgeGuard"),
    oracle,
  };
}

export interface FundingPlan {
  makerWbtc8: bigint;
  makerUsdc6: bigint;
  takerWbtc8: bigint;
  takerUsdc6: bigint;
}

export async function fundAccounts(clients: ForkClients, plan: FundingPlan): Promise<void> {
  const maker = clients.address("maker");
  const taker = clients.address("taker");
  for (const address of [clients.address("deployer"), clients.address("hedger"), maker, taker]) {
    await clients.testClient.setBalance({ address, value: ETH_FUNDING_WEI });
  }
  await setTokenBalance(clients, WBTC, maker, plan.makerWbtc8);
  await setTokenBalance(clients, USDC, maker, plan.makerUsdc6);
  await setTokenBalance(clients, WBTC, taker, plan.takerWbtc8);
  await setTokenBalance(clients, USDC, taker, plan.takerUsdc6);
}

export async function tokenBalance(
  clients: ForkClients,
  token: Address,
  holder: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  return clients.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
    blockNumber,
  });
}
