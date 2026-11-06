import { toBaseUnits, USDC_DECIMALS } from "@noirwire/shared";
import { z } from "zod";

export interface HyperCoreReader {
  balance(address: string): Promise<bigint>;
}

const perpsState = z.object({ marginSummary: z.object({ accountValue: z.string() }) });
const spotState = z.object({ balances: z.array(z.object({ coin: z.string(), total: z.string() })) });

export class HyperliquidInfoReader implements HyperCoreReader {
  constructor(
    private readonly infoUrl: string,
    private readonly dex: "perps" | "spot" = "perps",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async balance(address: string): Promise<bigint> {
    const type = this.dex === "perps" ? "clearinghouseState" : "spotClearinghouseState";
    const response = await this.fetchImpl(this.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, user: address }),
    });
    if (!response.ok) throw new Error(`Hyperliquid info ${response.status}`);
    const json: unknown = await response.json();
    if (this.dex === "perps") {
      return toBaseUnits(perpsState.parse(json).marginSummary.accountValue, USDC_DECIMALS);
    }
    const usdc = spotState.parse(json).balances.find((entry) => entry.coin === "USDC");
    return usdc ? toBaseUnits(usdc.total, USDC_DECIMALS) : 0n;
  }
}
