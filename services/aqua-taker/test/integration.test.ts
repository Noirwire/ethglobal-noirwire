import { flowEvent } from "@noirwire/shared";
import type { AddressInfo } from "node:net";
import { type Address, encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { testAggregatorAbi } from "../src/abis.ts";
import { Direction, ONE_BTC } from "../src/band.ts";
import { runTakerBot } from "../src/bot.ts";
import { createForkClients } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { DEMO_FUNDING, runDemo } from "../src/demo.ts";
import { USDC, WBTC, deployHedgeGuard, fundAccounts, setTokenBalance, tokenBalance } from "../src/fork-setup.ts";
import { INVENTORY_PATH, createInventoryReader, createInventoryServer } from "../src/inventory-server.ts";
import { parseAquaInventory } from "../../../workflows/cre/src/sources.ts";
import { AquaMaker } from "../src/maker.ts";
import { AquaTaker } from "../src/taker.ts";
import { sendCall } from "../src/tx.ts";

const forkRpc = process.env.AQUA_FORK_RPC;
const BTC = ONE_BTC;
const ARBITRUM_WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const SEVEN_HOURS = 7n * 3600n;

async function bootstrap() {
  const config = loadConfig({ AQUA_FORK_RPC: forkRpc });
  const clients = createForkClients(config.AQUA_FORK_RPC);
  await fundAccounts(clients, DEMO_FUNDING);
  const deployment = await deployHedgeGuard(clients, "test-aggregator");
  const maker = new AquaMaker(clients, deployment);
  const taker = new AquaTaker(clients, deployment);
  await taker.approveRouter();
  return { clients, deployment, maker, taker };
}

describe.skipIf(forkRpc === undefined)("aqua fork integration", () => {
  it("runs ship, allowed swap, wrong-way revert and dock against the official contracts", async () => {
    const config = loadConfig({ AQUA_FORK_RPC: forkRpc });
    const clients = createForkClients(config.AQUA_FORK_RPC);
    const lines: string[] = [];
    const report = await runDemo(clients, config, () => undefined, (line) => lines.push(line));

    expect(report.deployment.router).toBe("0x111111338c5091e8440b67b168bae16a668ac0de");
    expect(report.deployment.aqua).toBe("0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
    expect(report.allowedFilled).toBe(true);
    expect(report.wrongWayRejected).toBe(true);
    expect(report.wrongWayReason).toBe("HedgeGuard__WrongDirection");

    const { start, afterAllowed, afterWrongWay, end } = report.balances;
    const btcMoved = start.makerWbtc - afterAllowed.makerWbtc;
    expect(btcMoved).toBeGreaterThan(0n);
    expect(afterAllowed.takerWbtc - start.takerWbtc).toBe(btcMoved);
    expect(afterAllowed.makerUsdc - start.makerUsdc).toBe(start.takerUsdc - afterAllowed.takerUsdc);
    expect(afterWrongWay).toEqual(afterAllowed);
    expect(end).toEqual(afterWrongWay);
    expect(report.remainingAfterAllowed).toBe(50_000_000n - btcMoved);
    expect(report.virtualWbtcAfterDock).toBe(0n);
    expect(report.txs.wrongWaySwap).toBeDefined();

    const events = lines.map((line) => flowEvent.parse(JSON.parse(line)));
    expect(events.map((event) => (event.kind === "hedge" ? event.order.status : event.kind))).toEqual([
      "pending",
      "partial",
      "rejected",
      "cancelled",
    ]);
    for (const event of events) {
      expect(event.kind === "hedge" && event.order.venue).toBe("aqua");
    }
  });

  it("rejects a fill larger than the remaining target", async () => {
    const { maker, taker } = await bootstrap();
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 11n });
    await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: BTC / 1000n, ttlSeconds: 3600n });

    const outcome = await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" && outcome.revert?.name).toBe("HedgeGuard__SizeExceedsRemaining");
  });

  it("rejects fills once the target is cleared", async () => {
    const { maker, taker } = await bootstrap();
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 12n });
    await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: BTC / 10n, ttlSeconds: 3600n });
    const quoteBefore = await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n);
    expect(quoteBefore.kind).toBe("filled");

    await maker.clearTarget();
    const quote = await taker.quote(shipped.order, USDC, WBTC, 700_000_000n);
    expect(quote.ok).toBe(false);
    expect(!quote.ok && quote.revert?.name).toBe("HedgeGuard__TargetNotSet");
  });

  it("goes stale with the fork clock and recovers when the labelled test aggregator is refreshed", async () => {
    const { clients, deployment, maker, taker } = await bootstrap();
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 13n });
    await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: BTC / 2n, ttlSeconds: 2n * SEVEN_HOURS });

    await clients.testClient.increaseTime({ seconds: Number(SEVEN_HOURS) });
    await clients.testClient.mine({ blocks: 1 });
    const stale = await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n);
    expect(stale.kind === "rejected" && stale.revert?.name).toBe("HedgeGuard__OracleStale");

    await expect(maker.oraclePriceE8()).rejects.toThrow();

    const [, latestAnswer] = await clients.publicClient.readContract({
      address: deployment.oracle,
      abi: testAggregatorAbi,
      functionName: "latestRoundData",
    });
    await sendCall(clients, "deployer", {
      to: deployment.oracle,
      data: encodeFunctionData({ abi: testAggregatorAbi, functionName: "setAnswer", args: [latestAnswer] }),
      value: 0n,
    });
    const fresh = await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n);
    expect(fresh.kind).toBe("filled");
  });

  it("lets the taker bot drain a target in chunks and stop when it is exhausted", async () => {
    const { clients, deployment, maker } = await bootstrap();
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 14n });
    await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: 350_000n, ttlSeconds: 3600n });

    const result = await runTakerBot(
      clients,
      deployment,
      {
        order: shipped.order,
        maker: maker.address,
        strategyHash: shipped.strategyHash,
        chunk8: BTC / 1000n,
        maxFills: 10,
        pauseMs: 0,
        sourceFillId: "bot-test",
      },
      () => undefined,
    );
    const remaining = (await new AquaTaker(clients, deployment).readTarget(maker.address)).remaining;
    expect(result.fills).toBeGreaterThanOrEqual(4);
    expect(result.filled8 + remaining).toBe(350_000n);
    expect(remaining).toBeLessThan(100n);
  });

  it("keeps the reduced remaining when the hedger retries the same target id", async () => {
    const { maker, taker } = await bootstrap();
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 41n });
    const request = { direction: Direction.MakerSellsBtc, size8: BTC / 10n, ttlSeconds: 3600n } as const;
    const first = await maker.setTarget(request);
    expect((await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n)).kind).toBe("filled");
    const afterFill = (await taker.readTarget(maker.address)).remaining;

    const retry = await maker.setTarget({ ...request, targetId: first.targetId });
    expect(retry.target.remaining).toBe(afterFill);
    expect((await taker.readTarget(maker.address)).remaining).toBe(afterFill);
    await expect(maker.setTarget({ ...request, size8: BTC / 5n, targetId: first.targetId })).rejects.toThrow();
  });

  it("enforces an optional taker gate token that the setup can satisfy on the fork", async () => {
    const { clients, maker, taker } = await bootstrap();
    await setTokenBalance(clients, ARBITRUM_WETH, taker.address, 0n);
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 15n, takerGateToken: ARBITRUM_WETH });
    await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: BTC / 10n, ttlSeconds: 3600n });

    const blocked = await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n);
    expect(blocked.kind).toBe("rejected");

    await setTokenBalance(clients, ARBITRUM_WETH, taker.address, 1n);
    const allowed = await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n);
    expect(allowed.kind).toBe("filled");
  });

  it("serves the maker wallet balances, not wallet plus virtual, over HTTP", async () => {
    const { clients, maker, taker } = await bootstrap();
    const shipped = await maker.ship({ wbtcInventory8: BTC, salt: 31n });
    await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: BTC / 2n, ttlSeconds: 3600n });
    expect((await taker.swapAllowedDirection(shipped.order, maker.address, BTC / 100n)).kind).toBe("filled");

    const server = createInventoryServer(createInventoryReader(clients));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${INVENTORY_PATH}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      const inventory = parseAquaInventory(text);
      const block = await clients.publicClient.getBlock();
      expect(inventory.usdc6).toBe(await tokenBalance(clients, USDC, maker.address));
      expect(inventory.wbtcE8).toBe(await tokenBalance(clients, WBTC, maker.address));
      expect(inventory.wbtcE8).toBe(DEMO_FUNDING.makerWbtc8 - (await takerGain(clients, taker.address)));
      expect(inventory.observedAtMs).toBe(Number(block.timestamp) * 1000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function takerGain(clients: ReturnType<typeof createForkClients>, taker: Address): Promise<bigint> {
  return (await tokenBalance(clients, WBTC, taker)) - DEMO_FUNDING.takerWbtc8;
}
