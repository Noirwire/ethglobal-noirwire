import { abs, BPS, BPS_NUMBER, min, notionalUsd6 } from "../numbers.ts";
import { isValidPerpPrice, isValidSize, meetsMinNotional, roundSizeDown } from "../hl-rules.ts";
import type {
  AccountState,
  Clock,
  HedgeVenue,
  OrderStatus,
  PlaceIocRequest,
  PlaceResult,
  Side,
  VenueFill,
  VenueSpec,
} from "../types.ts";

export interface BookLevel {
  offsetBps: number;
  size8: bigint;
}

export interface MockVenueOptions {
  markPx8: bigint;
  accountValue6: bigint;
  clock?: Clock;
  spec?: Partial<VenueSpec>;
  depth?: BookLevel[];
  initialPosition8?: bigint;
}

interface RecordedOrder {
  request: PlaceIocRequest;
  status: OrderStatus;
}

export const DEFAULT_MOCK_SPEC: VenueSpec = {
  coin: "BTC",
  assetIndex: 0,
  szDecimals: 5,
  minNotional6: 10_000_000n,
  maxLeverage: 40,
};

export const DEFAULT_MOCK_DEPTH: BookLevel[] = [
  { offsetBps: 1, size8: 50_000_000n },
  { offsetBps: 3, size8: 100_000_000n },
  { offsetBps: 10, size8: 500_000_000n },
  { offsetBps: 40, size8: 5_000_000_000n },
];

export class MockVenue implements HedgeVenue {
  readonly spec: VenueSpec;
  readonly orders = new Map<string, RecordedOrder>();
  readonly fills: VenueFill[] = [];
  readonly placeCalls: PlaceIocRequest[] = [];
  readonly cancelCalls: string[] = [];

  markPx8: bigint;
  accountValue6: bigint;
  depth: BookLevel[];

  private positionSize8: bigint;
  private readonly clock: Clock;
  private fillCounter = 0;

  private rejectQueue: string[] = [];
  private throwAfterFillQueue: Error[] = [];
  private throwBeforeFillQueue: Error[] = [];
  private fillRatioQueue: number[] = [];
  private staleReadsRemaining = 0;
  private stalePosition8 = 0n;
  private failCancels = false;
  private outage = false;
  private hideOrderStatus = new Set<string>();
  private statusOverrides = new Map<string, OrderStatus>();
  private positionReadHook: (() => void) | null = null;

  constructor(options: MockVenueOptions) {
    this.spec = { ...DEFAULT_MOCK_SPEC, ...options.spec };
    this.markPx8 = options.markPx8;
    this.accountValue6 = options.accountValue6;
    this.depth = options.depth ?? DEFAULT_MOCK_DEPTH;
    this.positionSize8 = options.initialPosition8 ?? 0n;
    this.clock = options.clock ?? (() => Date.now());
  }

  get truePosition8(): bigint {
    return this.positionSize8;
  }

  rejectNext(reason: string): void {
    this.rejectQueue.push(reason);
  }

  throwAfterNextFill(error = new Error("request timed out")): void {
    this.throwAfterFillQueue.push(error);
  }

  throwBeforeNextFill(error = new Error("connection reset")): void {
    this.throwBeforeFillQueue.push(error);
  }

  fillRatioNext(ratio: number): void {
    this.fillRatioQueue.push(ratio);
  }

  serveStalePositionReads(count: number): void {
    this.stalePosition8 = this.positionSize8;
    this.staleReadsRemaining = count;
  }

  setCancelsFail(value: boolean): void {
    this.failCancels = value;
  }

  setOutage(value: boolean): void {
    this.outage = value;
  }

  hideStatusFor(cloid: string): void {
    this.hideOrderStatus.add(cloid);
  }

  overrideStatus(cloid: string, status: OrderStatus): void {
    this.statusOverrides.set(cloid, status);
  }

  onPositionRead(hook: (() => void) | null): void {
    this.positionReadHook = hook;
  }

  async position(): Promise<bigint> {
    this.assertUp();
    this.positionReadHook?.();
    if (this.staleReadsRemaining > 0) {
      this.staleReadsRemaining -= 1;
      return this.stalePosition8;
    }
    return this.positionSize8;
  }

  async accountState(): Promise<AccountState> {
    this.assertUp();
    const marginUsed = notionalUsd6(this.positionSize8, this.markPx8) / BigInt(this.spec.maxLeverage);
    return {
      accountValue6: this.accountValue6,
      totalMarginUsed6: marginUsed,
      withdrawable6: this.accountValue6 > marginUsed ? this.accountValue6 - marginUsed : 0n,
      markPx8: this.markPx8,
    };
  }

  async placeIoc(request: PlaceIocRequest): Promise<PlaceResult> {
    this.assertUp();
    this.placeCalls.push(request);
    const beforeError = this.throwBeforeFillQueue.shift();
    if (beforeError) throw beforeError;

    const result = this.execute(request);
    this.orders.set(request.cloid, { request, status: this.statusFromResult(result) });

    const afterError = this.throwAfterFillQueue.shift();
    if (afterError) throw afterError;
    return result;
  }

  async cancelByCloid(cloid: string): Promise<void> {
    this.assertUp();
    this.cancelCalls.push(cloid);
    if (this.failCancels) throw new Error("cancel failed");
  }

  async orderStatusByCloid(cloid: string): Promise<OrderStatus> {
    this.assertUp();
    const override = this.statusOverrides.get(cloid);
    if (override) return override;
    const order = this.orders.get(cloid);
    if (!order || this.hideOrderStatus.has(cloid)) return { state: "unknown", filled8: 0n };
    return order.status;
  }

  async fillsSince(timeMs: number): Promise<VenueFill[]> {
    this.assertUp();
    return this.fills.filter((fill) => fill.time >= timeMs);
  }

  private assertUp(): void {
    if (this.outage) throw new Error("venue unreachable");
  }

  private statusFromResult(result: PlaceResult): OrderStatus {
    if (result.outcome === "rejected") {
      return { state: "rejected", filled8: 0n, reason: result.reason };
    }
    if (result.filled8 === 0n) return { state: "cancelled", filled8: 0n, reason: result.reason };
    return {
      state: result.outcome === "filled" ? "filled" : "cancelled",
      filled8: result.filled8,
      avgPx8: result.avgPx8,
    };
  }

  private execute(request: PlaceIocRequest): PlaceResult {
    const invalid = this.validate(request);
    if (invalid) return { outcome: "rejected", filled8: 0n, reason: invalid };

    const scripted = this.rejectQueue.shift();
    if (scripted) return { outcome: "rejected", filled8: 0n, reason: scripted };

    const signed = request.side === "buy" ? request.size8 : -request.size8;
    const reduces = this.positionSize8 !== 0n && (this.positionSize8 > 0n) !== (signed > 0n);
    if (request.reduceOnly && !reduces) {
      return { outcome: "rejected", filled8: 0n, reason: "reduceOnlyRejected" };
    }
    const sizeCap = request.reduceOnly ? min(request.size8, abs(this.positionSize8)) : request.size8;

    const ratio = this.fillRatioQueue.shift() ?? 1;
    const wanted = roundSizeDown((sizeCap * BigInt(Math.round(ratio * BPS_NUMBER))) / BPS, this.spec.szDecimals);
    const walked = this.walkBook(request.side, wanted, request.limitPx8);
    if (walked.filled8 === 0n) {
      return { outcome: "unfilled", filled8: 0n, reason: "iocCancelRejected" };
    }

    const after = this.positionSize8 + (request.side === "buy" ? walked.filled8 : -walked.filled8);
    const marginAfter = notionalUsd6(after, this.markPx8) / BigInt(this.spec.maxLeverage);
    const increases = abs(after) > abs(this.positionSize8);
    if (increases && marginAfter > this.accountValue6) {
      return { outcome: "rejected", filled8: 0n, reason: "perpMarginRejected" };
    }

    this.positionSize8 = after;
    const avgPx8 = walked.notional / walked.filled8;
    this.fills.push({
      id: `mock-fill-${++this.fillCounter}`,
      cloid: request.cloid,
      side: request.side,
      size8: walked.filled8,
      px8: avgPx8,
      time: this.clock(),
    });
    return {
      outcome: walked.filled8 === request.size8 ? "filled" : "partial",
      filled8: walked.filled8,
      avgPx8,
    };
  }

  private validate(request: PlaceIocRequest): string | null {
    if (!isValidSize(request.size8, this.spec.szDecimals)) return "badSizeRejected";
    if (!isValidPerpPrice(request.limitPx8, this.spec.szDecimals)) return "tickRejected";
    if (!meetsMinNotional(request.size8, request.limitPx8, this.spec.minNotional6)) {
      return "minTradeNtlRejected";
    }
    return null;
  }

  private walkBook(side: Side, wanted: bigint, limitPx8: bigint): { filled8: bigint; notional: bigint } {
    let remaining = wanted;
    let filled8 = 0n;
    let notional = 0n;
    for (const level of this.depth) {
      if (remaining === 0n) break;
      const offset = (this.markPx8 * BigInt(level.offsetBps)) / BPS;
      const px8 = side === "buy" ? this.markPx8 + offset : this.markPx8 - offset;
      const crosses = side === "buy" ? px8 <= limitPx8 : px8 >= limitPx8;
      if (!crosses) break;
      const take = min(remaining, level.size8);
      filled8 += take;
      notional += take * px8;
      remaining -= take;
    }
    return { filled8, notional };
  }
}
