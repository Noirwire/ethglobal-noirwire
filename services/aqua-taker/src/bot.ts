import type { Order } from "@1inch/swap-vm-sdk";
import { BTC_DECIMALS, fromBaseUnits } from "@noirwire/shared";
import type { Address, Hex } from "viem";
import { Direction, PRICE_DECIMALS } from "./band.js";
import type { ForkClients } from "./chain.js";
import { aquaHedgeEvent, emitEvent } from "./events.js";
import type { Deployment } from "./fork-setup.js";
import { AquaTaker } from "./taker.js";

export interface BotParams {
  order: Order;
  maker: Address;
  strategyHash: Hex;
  chunk8: bigint;
  maxFills: number;
  pauseMs: number;
  sourceFillId: string;
}

export interface BotResult {
  fills: number;
  filled8: bigint;
  stoppedBecause: "exhausted" | "expired" | "no-target" | "max-fills" | "rejected";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTakerBot(
  clients: ForkClients,
  deployment: Deployment,
  params: BotParams,
  log: (line: string) => void,
): Promise<BotResult> {
  const taker = new AquaTaker(clients, deployment);
  await taker.approveRouter();
  const createdAt = new Date();
  let fills = 0;
  let filled8 = 0n;
  let openingSize8: bigint | undefined;

  while (fills < params.maxFills) {
    const target = await taker.readTarget(params.maker);
    const now = (await clients.publicClient.getBlock()).timestamp;
    if (target.direction === Direction.None) return { fills, filled8, stoppedBecause: "no-target" };
    if (now > target.expiry) return { fills, filled8, stoppedBecause: "expired" };
    if (target.remaining < params.chunk8) return { fills, filled8, stoppedBecause: "exhausted" };

    openingSize8 ??= target.remaining;
    const outcome = await taker.swapAllowedDirection(params.order, params.maker, params.chunk8);
    if (outcome.kind === "rejected") {
      log(`bot fill rejected: ${outcome.revert?.name ?? outcome.message}`);
      return { fills, filled8, stoppedBecause: "rejected" };
    }
    fills += 1;
    filled8 += outcome.btc8;
    log(
      `bot fill ${fills}: ${fromBaseUnits(outcome.btc8, BTC_DECIMALS)} WBTC at ${fromBaseUnits(outcome.priceE8, PRICE_DECIMALS)} USD, tx ${outcome.tx.hash}`,
    );
    emitEvent(
      aquaHedgeEvent({
        strategyHash: params.strategyHash,
        maker: params.maker,
        txHash: outcome.tx.hash,
        sourceFillIds: [params.sourceFillId],
        makerSellsBtc: target.direction === Direction.MakerSellsBtc,
        size8: openingSize8,
        limitPriceE8: target.direction === Direction.MakerSellsBtc ? target.minPriceE8 : target.maxPriceE8,
        status: target.remaining - outcome.btc8 < params.chunk8 ? "filled" : "partial",
        filledSize8: filled8,
        avgPriceE8: outcome.priceE8,
        createdAt,
        updatedAt: new Date(),
      }),
    );
    if (params.pauseMs > 0) await sleep(params.pauseMs);
  }
  return { fills, filled8, stoppedBecause: "max-fills" };
}
