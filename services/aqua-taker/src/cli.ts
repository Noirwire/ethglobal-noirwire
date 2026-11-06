import { BTC_DECIMALS, fromBaseUnits } from "@noirwire/shared";
import { Direction, ONE_BTC } from "./band.js";
import { runTakerBot } from "./bot.js";
import { createForkClients } from "./chain.js";
import { loadConfig } from "./config.js";
import { DEMO_FUNDING, DEMO_INVENTORY_8, TARGET_TTL_SECONDS, runDemo } from "./demo.js";
import { deployHedgeGuard, fundAccounts } from "./fork-setup.js";
import { createInventoryReader, createInventoryServer } from "./inventory-server.js";
import { AquaMaker } from "./maker.js";

const USAGE =
  "usage: aqua-taker <demo|bot|serve>\n  demo   ship, allowed swap, wrong-way swap (reverts), dock\n  bot    ship, then fill the target in small chunks until it is exhausted\n  serve  GET /v1/aqua/inventory: the maker wallet's USDC and WBTC at the latest block\n";

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function runBotScenario(): Promise<void> {
  const config = loadConfig();
  const clients = createForkClients(config.AQUA_FORK_RPC);
  await fundAccounts(clients, DEMO_FUNDING);
  const deployment = await deployHedgeGuard(clients, config.AQUA_ORACLE);
  const maker = new AquaMaker(clients, deployment);
  const shipped = await maker.ship({ wbtcInventory8: DEMO_INVENTORY_8, salt: BigInt(Date.now()) });
  log(`ship tx ${shipped.ship.hash} strategy ${shipped.strategyHash}`);
  await maker.setTarget({ direction: Direction.MakerSellsBtc, size8: ONE_BTC / 20n, ttlSeconds: TARGET_TTL_SECONDS });
  const result = await runTakerBot(
    clients,
    deployment,
    {
      order: shipped.order,
      maker: maker.address,
      strategyHash: shipped.strategyHash,
      chunk8: ONE_BTC / 100n,
      maxFills: 10,
      pauseMs: 0,
      sourceFillId: "aqua-bot-maker-inventory",
    },
    log,
  );
  log(`bot stopped (${result.stoppedBecause}) after ${result.fills} fills, ${fromBaseUnits(result.filled8, BTC_DECIMALS)} BTC`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "demo") {
    const config = loadConfig();
    const report = await runDemo(createForkClients(config.AQUA_FORK_RPC), config, log);
    log(JSON.stringify(report.txs, null, 2));
    if (!report.allowedFilled || !report.wrongWayRejected) process.exitCode = 1;
    return;
  }
  if (command === "bot") {
    await runBotScenario();
    return;
  }
  if (command === "serve") {
    const config = loadConfig();
    const server = createInventoryServer(createInventoryReader(createForkClients(config.AQUA_FORK_RPC)));
    server.listen(config.AQUA_HTTP_PORT, "127.0.0.1", () => log(`inventory listening on 127.0.0.1:${config.AQUA_HTTP_PORT}`));
    return;
  }
  process.stderr.write(USAGE);
  process.exitCode = command === undefined ? 0 : 2;
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
