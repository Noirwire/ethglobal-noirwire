import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { btcFromDecimal, btcToDecimal, priceFromDecimal, priceToDecimal, usdFromDecimal } from "../numbers.ts";
import { isValidPerpPrice, isValidSize } from "../hl-rules.ts";
import type {
  AccountState,
  HedgeVenue,
  OrderStatus,
  PlaceIocRequest,
  PlaceResult,
  VenueFill,
  VenueSpec,
} from "../types.ts";

const HL_DEFAULT_MIN_NOTIONAL6 = 10_000_000n;

interface HlUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface HlInfoLike {
  meta(): Promise<{ universe: HlUniverseEntry[] }>;
  metaAndAssetCtxs(): Promise<[{ universe: HlUniverseEntry[] }, Array<{ markPx: string }>]>;
  clearinghouseState(params: { user: `0x${string}` }): Promise<{
    marginSummary: { accountValue: string; totalMarginUsed: string };
    withdrawable: string;
    assetPositions: Array<{ position: { coin: string; szi: string } }>;
  }>;
  orderStatus(params: { user: `0x${string}`; oid: `0x${string}` }): Promise<
    | { status: "unknownOid" }
    | { status: "order"; order: { status: string; order: { origSz: string; sz: string } } }
  >;
  userFillsByTime(params: { user: `0x${string}`; startTime: number }): Promise<
    Array<{ coin: string; px: string; sz: string; side: "B" | "A"; time: number; tid: number; oid: number }>
  >;
}

export interface HlOrderParams {
  orders: Array<{
    a: number;
    b: boolean;
    p: string;
    s: string;
    r: boolean;
    t: { limit: { tif: "Ioc" } };
    c: `0x${string}`;
  }>;
  grouping: "na";
}

export type HlOrderStatusEntry =
  | { resting: { oid: number } }
  | { filled: { totalSz: string; avgPx: string; oid: number } }
  | { error: string }
  | string;

export interface HlExchangeLike {
  order(params: HlOrderParams): Promise<{ response: { data: { statuses: HlOrderStatusEntry[] } } }>;
  cancelByCloid(params: { cancels: Array<{ asset: number; cloid: `0x${string}` }> }): Promise<{
    response: { data: { statuses: Array<string | { error: string }> } };
  }>;
}

export interface HyperliquidVenueOptions {
  coin: string;
  accountAddress: `0x${string}`;
  info: HlInfoLike;
  exchange: HlExchangeLike | null;
}

const NO_MATCH_MARKER = "could not immediately match";

async function loadSpec(info: HlInfoLike, coin: string): Promise<VenueSpec> {
  const { universe } = await info.meta();
  const assetIndex = universe.findIndex((entry) => entry.name === coin);
  const entry = universe[assetIndex];
  if (!entry) throw new Error(`Hyperliquid universe has no ${coin} perp`);
  return {
    coin: entry.name,
    assetIndex,
    szDecimals: entry.szDecimals,
    maxLeverage: entry.maxLeverage,
    minNotional6: HL_DEFAULT_MIN_NOTIONAL6,
  };
}

export class HyperliquidVenue implements HedgeVenue {
  private constructor(
    readonly spec: VenueSpec,
    private readonly options: HyperliquidVenueOptions,
  ) {}

  static async connect(options: HyperliquidVenueOptions): Promise<HyperliquidVenue> {
    return new HyperliquidVenue(await loadSpec(options.info, options.coin), options);
  }

  async position(): Promise<bigint> {
    const state = await this.options.info.clearinghouseState({ user: this.options.accountAddress });
    const entry = state.assetPositions.find((item) => item.position.coin === this.spec.coin);
    return entry ? btcFromDecimal(entry.position.szi) : 0n;
  }

  async accountState(): Promise<AccountState> {
    const [state, contexts] = await Promise.all([
      this.options.info.clearinghouseState({ user: this.options.accountAddress }),
      this.options.info.metaAndAssetCtxs(),
    ]);
    const context = contexts[1][this.spec.assetIndex];
    if (!context) throw new Error("no asset context for BTC");
    return {
      accountValue6: usdFromDecimal(state.marginSummary.accountValue),
      totalMarginUsed6: usdFromDecimal(state.marginSummary.totalMarginUsed),
      withdrawable6: usdFromDecimal(state.withdrawable),
      markPx8: priceFromDecimal(context.markPx),
    };
  }

  async placeIoc(request: PlaceIocRequest): Promise<PlaceResult> {
    const exchange = this.requireExchange();
    this.assertWellFormed(request);
    const response = await exchange.order({
      orders: [
        {
          a: this.spec.assetIndex,
          b: request.side === "buy",
          p: priceToDecimal(request.limitPx8),
          s: btcToDecimal(request.size8),
          r: request.reduceOnly,
          t: { limit: { tif: "Ioc" } },
          c: request.cloid as `0x${string}`,
        },
      ],
      grouping: "na",
    });
    const status = response.response.data.statuses[0];
    return this.mapPlaceStatus(status, request);
  }

  async cancelByCloid(cloid: string): Promise<void> {
    const exchange = this.requireExchange();
    const response = await exchange.cancelByCloid({
      cancels: [{ asset: this.spec.assetIndex, cloid: cloid as `0x${string}` }],
    });
    const status = response.response.data.statuses[0];
    if (typeof status === "object" && status !== null && "error" in status) {
      throw new Error(`cancel failed: ${status.error}`);
    }
  }

  async orderStatusByCloid(cloid: string): Promise<OrderStatus> {
    const result = await this.options.info.orderStatus({
      user: this.options.accountAddress,
      oid: cloid as `0x${string}`,
    });
    if (result.status === "unknownOid") return { state: "unknown", filled8: 0n };
    const { status, order } = result.order;
    const filled8 = btcFromDecimal(order.origSz) - btcFromDecimal(order.sz);
    return { ...mapProcessingStatus(status), filled8: filled8 > 0n ? filled8 : 0n, reason: status };
  }

  async fillsSince(timeMs: number): Promise<VenueFill[]> {
    const fills = await this.options.info.userFillsByTime({
      user: this.options.accountAddress,
      startTime: timeMs,
    });
    return fills
      .filter((fill) => fill.coin === this.spec.coin)
      .map((fill) => ({
        id: `${fill.oid}:${fill.tid}`,
        side: fill.side === "B" ? ("buy" as const) : ("sell" as const),
        size8: btcFromDecimal(fill.sz),
        px8: priceFromDecimal(fill.px),
        time: fill.time,
      }));
  }

  private requireExchange(): HlExchangeLike {
    if (!this.options.exchange) throw new Error("no agent key configured: venue is read-only");
    return this.options.exchange;
  }

  private assertWellFormed(request: PlaceIocRequest): void {
    if (!isValidSize(request.size8, this.spec.szDecimals)) {
      throw new Error(`size ${request.size8} violates szDecimals ${this.spec.szDecimals}`);
    }
    if (!isValidPerpPrice(request.limitPx8, this.spec.szDecimals)) {
      throw new Error(`price ${request.limitPx8} violates tick rules`);
    }
  }

  private mapPlaceStatus(status: HlOrderStatusEntry | undefined, request: PlaceIocRequest): PlaceResult {
    if (status && typeof status === "object" && "filled" in status) {
      const filled8 = btcFromDecimal(status.filled.totalSz);
      return {
        outcome: filled8 >= request.size8 ? "filled" : "partial",
        filled8,
        avgPx8: priceFromDecimal(status.filled.avgPx),
      };
    }
    if (status && typeof status === "object" && "error" in status) {
      const noMatch = status.error.toLowerCase().includes(NO_MATCH_MARKER);
      return { outcome: noMatch ? "unfilled" : "rejected", filled8: 0n, reason: status.error };
    }
    throw new Error(`unexpected order status ${JSON.stringify(status)}`);
  }
}

function mapProcessingStatus(status: string): Pick<OrderStatus, "state"> {
  if (status === "filled") return { state: "filled" };
  if (status === "open" || status === "triggered") return { state: "open" };
  if (status.toLowerCase().includes("rejected")) return { state: "rejected" };
  return { state: "cancelled" };
}

export interface HyperliquidConnectionConfig {
  coin: string;
  isTestnet: boolean;
  accountAddress: `0x${string}`;
  agentPrivateKey: `0x${string}` | null;
}

export async function connectHyperliquid(config: HyperliquidConnectionConfig): Promise<HyperliquidVenue> {
  const transport = new HttpTransport({ isTestnet: config.isTestnet });
  const info = new InfoClient({ transport }) as unknown as HlInfoLike;
  const exchange = config.agentPrivateKey
    ? (new ExchangeClient({
        transport,
        wallet: privateKeyToAccount(config.agentPrivateKey),
      }) as unknown as HlExchangeLike)
    : null;
  return HyperliquidVenue.connect({
    coin: config.coin,
    accountAddress: config.accountAddress,
    info,
    exchange,
  });
}

export async function fetchHyperliquidSpec(coin: string, isTestnet: boolean): Promise<VenueSpec> {
  const transport = new HttpTransport({ isTestnet });
  return loadSpec(new InfoClient({ transport }) as unknown as HlInfoLike, coin);
}
