import type { MakerFill } from "@noirwire/shared";
import { HedgeController, type ControllerConfig } from "../src/controller.ts";
import { EventBus } from "../src/events.ts";
import { Journal, MemoryJournalStore } from "../src/journal.ts";
import { ReplayFillSource } from "../src/sources/replay.ts";
import type { AquaOutlet, ReferencePriceSource } from "../src/types.ts";
import { MockVenue, type MockVenueOptions } from "../src/venue/mock-venue.ts";

export const MARK_PX8 = 100_000n * 100_000_000n;
export const START_MS = 1_800_000_000_000;

export class TestClock {
  constructor(public nowMs = START_MS) {}
  now = (): number => this.nowMs;
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

export function cloidFor(n: number): string {
  return `0x${n.toString(16).padStart(32, "0")}`;
}

export function counterCloids(): () => string {
  let n = 0;
  return () => cloidFor(++n);
}

export function makeFill(id: string, makerSide: "buy" | "sell", size8: bigint, market = "NBTC-PERP"): MakerFill {
  return {
    fillId: id,
    market,
    makerSide,
    size: size8.toString(),
    price: "100000",
    filledAt: new Date(START_MS).toISOString(),
  };
}

export interface HarnessOptions {
  venue?: Partial<MockVenueOptions>;
  config?: Partial<ControllerConfig>;
  store?: MemoryJournalStore;
  clock?: TestClock;
  source?: ReplayFillSource;
  reference?: ReferencePriceSource;
  aqua?: AquaOutlet;
  newCloid?: () => string;
}

export function makeHarness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new TestClock();
  const venue = new MockVenue({
    markPx8: MARK_PX8,
    accountValue6: 50_000_000_000n,
    clock: clock.now,
    ...options.venue,
  });
  const source = options.source ?? new ReplayFillSource([], 50);
  const store = options.store ?? new MemoryJournalStore();
  const bus = new EventBus();
  const controller = new HedgeController({
    venue,
    fillSource: source,
    journal: new Journal(store),
    bus,
    clock: clock.now,
    newCloid: options.newCloid ?? counterCloids(),
    config: options.config,
    reference: options.reference,
    aqua: options.aqua,
  });
  return { clock, venue, source, store, bus, controller };
}

export function netResidual8(controller: HedgeController, venue: MockVenue): bigint {
  return controller.makerPosition8 + venue.truePosition8;
}
