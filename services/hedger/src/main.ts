import { pathToFileURL } from "node:url";
import type { FlowEvent } from "@noirwire/shared";
import { parseConfig, type HedgerConfig } from "./config.ts";
import { DEFAULT_CONTROLLER_CONFIG, HedgeController } from "./controller.ts";
import { createEventServer, EventBus } from "./events.ts";
import { FileJournalStore, Journal, MemoryJournalStore } from "./journal.ts";
import { ReplayFillSource, scriptedDemoFills } from "./sources/replay.ts";
import { TapeFillSource } from "./sources/tape.ts";
import { connectHyperliquid } from "./venue/hyperliquid-venue.ts";
import { MockVenue } from "./venue/mock-venue.ts";
import type { FillSource, HedgeVenue } from "./types.ts";

const DEMO_TICK_MS = 60;
const DEMO_MAX_TICKS = 400;
const DEMO_SETTLED_TICKS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildVenue(config: HedgerConfig): Promise<{ venue: HedgeVenue; mock: MockVenue | null }> {
  if (config.mode === "mock") {
    const mock = new MockVenue({ markPx8: 100_000n * 100_000_000n, accountValue6: 20_000_000_000n });
    return { venue: mock, mock };
  }
  if (!config.accountAddress) throw new Error("HL_ACCOUNT_ADDRESS is required in testnet mode");
  const venue = await connectHyperliquid({
    coin: config.hedgeCoin,
    isTestnet: true,
    accountAddress: config.accountAddress,
    agentPrivateKey: config.hedgeEnabled ? (config.agentPrivateKey ?? null) : null,
  });
  return { venue, mock: null };
}

function buildFillSource(config: HedgerConfig): ReplayFillSource | TapeFillSource {
  if (config.fillSource === "tape") {
    return new TapeFillSource({
      bookApiUrl: config.bookApiUrl ?? "",
      market: config.bookMarket,
      houseMakerTag: config.houseMakerTag,
      cursorFile: config.cursorFile,
    });
  }
  if (config.replayFile) return ReplayFillSource.fromFile(config.replayFile);
  return new ReplayFillSource(scriptedDemoFills(config.bookMarket, Date.now()));
}

function describeEvent(event: FlowEvent): string {
  switch (event.kind) {
    case "fill":
      return `fill ${event.fill.fillId} maker ${event.fill.makerSide} ${event.fill.size} @ ${event.fill.price}`;
    case "hedge":
      return `hedge ${event.order.status} ${event.order.side} ${event.order.size} (filled ${event.order.filledSize})`;
    case "exposure":
      return `exposure maker ${event.exposure.makerPosition} venue ${event.exposure.hyperliquidPosition} net ${event.exposure.netResidual}`;
    case "intent":
      return `intent ${event.intent.reason} ${event.intent.amount} ratio ${event.intent.marginRatioBps}`;
    default:
      return event.kind;
  }
}

function injectDemoFaults(mock: MockVenue, tickNumber: number): void {
  if (tickNumber === 2) mock.fillRatioNext(0.5);
  if (tickNumber === 5) mock.rejectNext("perpMarginRejected");
  if (tickNumber === 3) {
    mock.throwAfterNextFill();
    mock.setCancelsFail(true);
  }
  if (tickNumber === 7) mock.serveStalePositionReads(2);
}

async function runDemo(controller: HedgeController, source: ReplayFillSource, mock: MockVenue): Promise<void> {
  let settledTicks = 0;
  for (let tickNumber = 1; tickNumber <= DEMO_MAX_TICKS; tickNumber += 1) {
    injectDemoFaults(mock, tickNumber);
    const report = await controller.tick();
    const settled = report.decision === "hold:within-deadband" && source.remaining === 0;
    settledTicks = settled ? settledTicks + 1 : 0;
    if (settledTicks >= DEMO_SETTLED_TICKS) break;
    await sleep(DEMO_TICK_MS);
  }
  const snapshot = controller.snapshot();
  console.log("---");
  console.log(`status: ${snapshot.status} (quote policy: ${snapshot.quotePolicy.mode})`);
  console.log(`maker position ${snapshot.makerPosition} BTC, hedge position ${snapshot.hyperliquidPosition} BTC`);
  console.log(`net residual ${snapshot.netResidual} BTC, unhedged notional ${snapshot.unhedgedNotionalUsd6} (usd 6dp)`);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = parseConfig(env);
  const demo = config.mode === "mock" && config.fillSource === "replay";
  const { venue, mock } = await buildVenue(config);
  const bus = new EventBus(config.eventsFile);
  const journal = new Journal(demo ? new MemoryJournalStore() : new FileJournalStore(config.journalFile));
  const fillSource: FillSource = buildFillSource(config);

  const controller = new HedgeController({
    venue,
    fillSource,
    journal,
    bus,
    config: {
      market: config.bookMarket,
      enabled: config.hedgeEnabled,
      deadband8: config.deadband8,
      maxOrder8: config.maxOrder8,
      priceBandBps: config.priceBandBps,
      softLimitUsd6: config.softLimitUsd6,
      hardLimitUsd6: config.hardLimitUsd6,
      referenceMaxAgeMs: config.referenceMaxAgeMs,
      confirmMaxAgeMs: config.confirmMaxAgeMs,
      blindAfterMs: config.blindAfterMs,
      unknownOrderGraceMs: demo ? 0 : config.unknownOrderGraceMs,
      leverageTarget: config.leverageTarget,
      initialMakerPosition8: config.initialMakerPosition8,
      backoffBaseMs: demo ? DEMO_TICK_MS : DEFAULT_CONTROLLER_CONFIG.backoffBaseMs,
      backoffMaxMs: demo ? DEMO_TICK_MS * 4 : DEFAULT_CONTROLLER_CONFIG.backoffMaxMs,
    },
  });

  const server = createEventServer(bus, { snapshot: () => controller.snapshot() });
  await new Promise<void>((resolve) => server.listen(config.httpPort, resolve));
  console.log(`hedger: ${config.mode} venue, ${config.fillSource} fills, hedging ${config.hedgeEnabled ? "on" : "off"}`);
  console.log(`hedger: GET http://localhost:${config.httpPort}/status and /events`);
  bus.subscribe((event) => console.log(`  ${describeEvent(event)}`));

  await controller.start();

  if (demo && mock && fillSource instanceof ReplayFillSource) {
    await runDemo(controller, fillSource, mock);
    if (!config.keepAlive) {
      server.close();
      server.closeAllConnections();
      return;
    }
  }

  let running = true;
  process.on("SIGINT", () => {
    running = false;
    server.close();
    server.closeAllConnections();
  });
  while (running) {
    const report = await controller.tick().catch((error: unknown) => {
      console.error(`tick failed: ${String(error)}`);
      return null;
    });
    await sleep(report && report.fillsProcessed > 0 ? 0 : config.tickMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
