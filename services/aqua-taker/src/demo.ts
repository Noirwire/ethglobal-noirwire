import { BTC_DECIMALS, type FlowEvent, USDC_DECIMALS, fromBaseUnits } from "@noirwire/shared";
import type { Hex } from "viem";
import { Direction, ONE_BTC, PRICE_DECIMALS, impliedPriceE8 } from "./band.js";
import type { ForkClients } from "./chain.js";
import { type Config } from "./config.js";
import { aquaHedgeEvent, emitEvent } from "./events.js";
import { AquaMaker } from "./maker.js";
import {
  type Deployment,
  type FundingPlan,
  USDC,
  WBTC,
  deployHedgeGuard,
  fundAccounts,
  setTokenBalance,
  tokenBalance,
} from "./fork-setup.js";
import { AquaTaker, type SwapOutcome } from "./taker.js";

const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);
export const DEMO_FUNDING: FundingPlan = {
  makerWbtc8: 2n * ONE_BTC,
  makerUsdc6: 1_000n * ONE_USDC,
  takerWbtc8: ONE_BTC,
  takerUsdc6: 500_000n * ONE_USDC,
};
export const DEMO_INVENTORY_8 = ONE_BTC;
const TARGET_SIZE_8 = ONE_BTC / 2n;
const ALLOWED_FILL_8 = ONE_BTC / 100n;
const WRONG_WAY_FILL_8 = ONE_BTC / 200n;
export const TARGET_TTL_SECONDS = 3600n;
const SOURCE_FILL_ID = "aqua-demo-maker-inventory";

export interface Balances {
  makerWbtc: bigint;
  makerUsdc: bigint;
  takerWbtc: bigint;
  takerUsdc: bigint;
}

export interface DemoReport {
  deployment: Deployment;
  strategyHash: Hex;
  txs: {
    deployOracleMode: string;
    approvals: Hex[];
    ship: Hex;
    setTarget: Hex;
    allowedSwap: Hex | undefined;
    wrongWaySwap: Hex | undefined;
    dock: Hex;
  };
  allowedFilled: boolean;
  wrongWayRejected: boolean;
  wrongWayReason: string | undefined;
  balances: { start: Balances; afterAllowed: Balances; afterWrongWay: Balances; end: Balances };
  remainingAfterAllowed: bigint;
  virtualWbtcAfterDock: bigint;
}

async function snapshot(clients: ForkClients): Promise<Balances> {
  const maker = clients.address("maker");
  const taker = clients.address("taker");
  return {
    makerWbtc: await tokenBalance(clients, WBTC, maker),
    makerUsdc: await tokenBalance(clients, USDC, maker),
    takerWbtc: await tokenBalance(clients, WBTC, taker),
    takerUsdc: await tokenBalance(clients, USDC, taker),
  };
}

export function describeDelta(from: Balances, to: Balances): string[] {
  const line = (label: string, before: bigint, after: bigint, decimals: number): string => {
    const delta = after - before;
    const sign = delta > 0n ? "+" : "";
    return `${label}: ${fromBaseUnits(before, decimals)} -> ${fromBaseUnits(after, decimals)} (${sign}${fromBaseUnits(delta, decimals)})`;
  };
  return [
    line("maker WBTC", from.makerWbtc, to.makerWbtc, BTC_DECIMALS),
    line("maker USDC", from.makerUsdc, to.makerUsdc, USDC_DECIMALS),
    line("taker WBTC", from.takerWbtc, to.takerWbtc, BTC_DECIMALS),
    line("taker USDC", from.takerUsdc, to.takerUsdc, USDC_DECIMALS),
  ];
}

function revertLabel(outcome: SwapOutcome): string | undefined {
  if (outcome.kind !== "rejected") return undefined;
  return outcome.revert?.name ?? outcome.message;
}

export async function runDemo(
  clients: ForkClients,
  config: Config,
  log: (line: string) => void,
  write: (line: string) => unknown = (line) => process.stdout.write(line),
): Promise<DemoReport> {
  const emit = (event: FlowEvent): void => emitEvent(event, write);
  log(`oracle mode: ${config.AQUA_ORACLE}${config.AQUA_ORACLE === "test-aggregator" ? " (TEST AGGREGATOR, NOT CHAINLINK)" : ""}`);
  await fundAccounts(clients, DEMO_FUNDING);
  const deployment = await deployHedgeGuard(clients, config.AQUA_ORACLE);
  log(`official Aqua registry ${deployment.aqua}, SwapVM router ${deployment.router}`);
  log(`HedgeGuard deployed at ${deployment.hedgeGuard}, oracle ${deployment.oracle}`);

  const gateToken = config.AQUA_TAKER_GATE_TOKEN;
  if (gateToken !== undefined) {
    await setTokenBalance(clients, gateToken,clients.address("taker"), 1n);
    log(`taker gate token ${gateToken} balance set to 1 on the fork`);
  }

  const maker = new AquaMaker(clients, deployment);
  const taker = new AquaTaker(clients, deployment);
  const start = await snapshot(clients);

  const shipped = await maker.ship({
    wbtcInventory8: DEMO_INVENTORY_8,
    salt: BigInt(Date.now()),
    takerGateToken: gateToken,
  });
  log(`ship tx ${shipped.ship.hash} strategy ${shipped.strategyHash}`);

  const { tx: targetTx, target } = await maker.setTarget({
    direction: Direction.MakerSellsBtc,
    size8: TARGET_SIZE_8,
    ttlSeconds: TARGET_TTL_SECONDS,
  });
  log(`hedger target tx ${targetTx.hash}: maker sells up to ${fromBaseUnits(TARGET_SIZE_8, BTC_DECIMALS)} BTC`);

  const createdAt = new Date();
  const eventBase = {
    strategyHash: shipped.strategyHash,
    maker: maker.address,
    sourceFillIds: [SOURCE_FILL_ID],
    makerSellsBtc: true,
    size8: TARGET_SIZE_8,
    limitPriceE8: target.minPriceE8,
    createdAt,
  };
  emit(
    aquaHedgeEvent({
      ...eventBase,
      txHash: shipped.ship.hash,
      status: "pending",
      filledSize8: 0n,
      updatedAt: new Date(),
    }),
  );

  const approvals = (await taker.approveRouter()).map((tx) => tx.hash);

  const allowed = await taker.swapAllowedDirection(shipped.order, maker.address, ALLOWED_FILL_8);
  const afterAllowed = await snapshot(clients);
  if (allowed.kind === "filled") {
    log(
      `allowed swap tx ${allowed.tx.hash}: taker bought ${fromBaseUnits(allowed.btc8, BTC_DECIMALS)} WBTC at ${fromBaseUnits(allowed.priceE8, PRICE_DECIMALS)} USD`,
    );
    emit(
      aquaHedgeEvent({
        ...eventBase,
        txHash: allowed.tx.hash,
        status: "partial",
        filledSize8: allowed.btc8,
        avgPriceE8: allowed.priceE8,
        updatedAt: new Date(),
      }),
    );
  } else {
    log(`allowed swap unexpectedly rejected: ${revertLabel(allowed)}`);
  }
  for (const line of describeDelta(start, afterAllowed)) log(`  ${line}`);
  const remainingAfterAllowed = (await taker.readTarget(maker.address)).remaining;

  const wrongWay = await taker.swapWrongDirection(shipped.order, maker.address, WRONG_WAY_FILL_8);
  const afterWrongWay = await snapshot(clients);
  const wrongWayReason = revertLabel(wrongWay);
  if (wrongWay.kind === "rejected") {
    log(`wrong-way swap rejected (${wrongWayReason}); reverting tx ${wrongWay.tx?.hash ?? "none sent"}`);
    emit(
      aquaHedgeEvent({
        ...eventBase,
        txHash: wrongWay.tx?.hash,
        status: "rejected",
        filledSize8: 0n,
        error: wrongWayReason,
        updatedAt: new Date(),
      }),
    );
  } else {
    log("wrong-way swap was accepted, which must never happen");
  }
  for (const line of describeDelta(afterAllowed, afterWrongWay)) log(`  ${line}`);

  await maker.clearTarget();
  const dock = await maker.dock(shipped.order);
  log(`dock tx ${dock.hash}`);
  const end = await snapshot(clients);
  const virtualWbtcAfterDock = await maker.virtualBalance(shipped.strategyHash, WBTC);
  emit(
    aquaHedgeEvent({
      ...eventBase,
      txHash: dock.hash,
      status: "cancelled",
      filledSize8: allowed.kind === "filled" ? allowed.btc8 : 0n,
      avgPriceE8: allowed.kind === "filled" ? impliedPriceE8(allowed.quote.amountIn, allowed.quote.amountOut) : undefined,
      updatedAt: new Date(),
    }),
  );
  log("balance change over the whole run:");
  for (const line of describeDelta(start, end)) log(`  ${line}`);

  return {
    deployment,
    strategyHash: shipped.strategyHash,
    txs: {
      deployOracleMode: config.AQUA_ORACLE,
      approvals: [...shipped.approvals.map((tx) => tx.hash), ...approvals],
      ship: shipped.ship.hash,
      setTarget: targetTx.hash,
      allowedSwap: allowed.kind === "filled" ? allowed.tx.hash : allowed.tx?.hash,
      wrongWaySwap: wrongWay.kind === "rejected" ? wrongWay.tx?.hash : undefined,
      dock: dock.hash,
    },
    allowedFilled: allowed.kind === "filled",
    wrongWayRejected: wrongWay.kind === "rejected",
    wrongWayReason,
    balances: { start, afterAllowed, afterWrongWay, end },
    remainingAfterAllowed,
    virtualWbtcAfterDock,
  };
}
