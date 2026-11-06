import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.ts";
import { assertBtcPerpMarket, HedgeController, HedgerGuardError } from "../src/controller.ts";
import { Journal, MemoryJournalStore } from "../src/journal.ts";
import { EventBus } from "../src/events.ts";
import { ReplayFillSource } from "../src/sources/replay.ts";
import { MockVenue } from "../src/venue/mock-venue.ts";

const ADDRESS = `0x${"ab".repeat(20)}`;
const KEY = `0x${"cd".repeat(32)}`;

function controllerFor(market: string, coin = "BTC"): HedgeController {
  return new HedgeController({
    venue: new MockVenue({ markPx8: 100_000n * 100_000_000n, accountValue6: 1_000_000_000n, spec: { coin } }),
    fillSource: new ReplayFillSource([]),
    journal: new Journal(new MemoryJournalStore()),
    bus: new EventBus(),
    config: { market },
  });
}

describe("market guard", () => {
  it("refuses to start for a market that is not a BTC perp", () => {
    for (const market of ["NETH-PERP", "ETH-PERP", "NBTC-SPOT", "SOL-PERP", "NBTC-PERP-2", ""]) {
      expect(() => controllerFor(market)).toThrow(HedgerGuardError);
    }
  });

  it("refuses a venue coin other than BTC", () => {
    expect(() => controllerFor("NBTC-PERP", "ETH")).toThrow(HedgerGuardError);
  });

  it("accepts the configured BTC perp markets", () => {
    expect(() => controllerFor("NBTC-PERP")).not.toThrow();
    expect(() => assertBtcPerpMarket("BTC-PERP", "BTC")).not.toThrow();
  });
});

describe("HEDGE_ENABLED", () => {
  it("accepts exactly 0 and 1", () => {
    expect(parseConfig({ HEDGE_ENABLED: "1" }).hedgeEnabled).toBe(true);
    expect(parseConfig({ HEDGE_ENABLED: "0" }).hedgeEnabled).toBe(false);
  });

  it("rejects every other spelling", () => {
    for (const value of ["true", "false", "yes", "TRUE", " 1", "1 ", "01", "2", ""]) {
      expect(() => parseConfig({ HEDGE_ENABLED: value }), JSON.stringify(value)).toThrow(ConfigError);
    }
  });

  it("must be set explicitly in testnet mode", () => {
    expect(() => parseConfig({ HEDGER_MODE: "testnet" })).toThrow(/HEDGE_ENABLED/);
  });

  it("fails at start with a clear message when enabled without a venue configured", () => {
    expect(() => parseConfig({ HEDGER_MODE: "testnet", HEDGE_ENABLED: "1" })).toThrow(
      /HEDGE_ENABLED=1 but no Hyperliquid venue is configured/,
    );
    expect(() =>
      parseConfig({ HEDGER_MODE: "testnet", HEDGE_ENABLED: "1", HL_ACCOUNT_ADDRESS: ADDRESS }),
    ).toThrow(/no Hyperliquid venue/);
  });

  it("allows observe-only mode and a fully configured venue", () => {
    expect(parseConfig({ HEDGER_MODE: "testnet", HEDGE_ENABLED: "0" }).hedgeEnabled).toBe(false);
    const config = parseConfig({
      HEDGER_MODE: "testnet",
      HEDGE_ENABLED: "1",
      HL_ACCOUNT_ADDRESS: ADDRESS,
      HL_AGENT_PRIVATE_KEY: KEY,
    });
    expect(config.hedgeEnabled).toBe(true);
    expect(config.accountAddress).toBe(ADDRESS);
  });
});

describe("config parsing", () => {
  it("defaults to the mock demo", () => {
    const config = parseConfig({});
    expect(config).toMatchObject({ mode: "mock", fillSource: "replay", hedgeEnabled: true, httpPort: 8701 });
  });

  it("requires a book url for the tape source and ordered limits", () => {
    expect(() => parseConfig({ FILL_SOURCE: "tape" })).toThrow(/BOOK_API_URL/);
    expect(() => parseConfig({ SOFT_LIMIT_USD: "500", HARD_LIMIT_USD: "100" })).toThrow(/SOFT_LIMIT_USD/);
  });

  it("accepts an optional decimal house maker tag", () => {
    expect(parseConfig({}).houseMakerTag).toBeUndefined();
    expect(parseConfig({ HOUSE_MAKER_TAG: "123456789012345678901" }).houseMakerTag).toBe("123456789012345678901");
    expect(() => parseConfig({ HOUSE_MAKER_TAG: "0xabc" })).toThrow(/HOUSE_MAKER_TAG/);
  });

  it("keeps the hedge leverage target between 3x and 5x", () => {
    expect(() => parseConfig({ HEDGE_LEVERAGE_TARGET: "2" })).toThrow(ConfigError);
    expect(() => parseConfig({ HEDGE_LEVERAGE_TARGET: "6" })).toThrow(ConfigError);
    expect(parseConfig({ HEDGE_LEVERAGE_TARGET: "5" }).leverageTarget).toBe(5);
  });
});
