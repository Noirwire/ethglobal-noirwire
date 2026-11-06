import { randomBytes } from "node:crypto";
import type { HedgeOrder, MakerFill, TopUpIntent } from "@noirwire/shared";
import { NoopAquaOutlet } from "./aqua.ts";
import {
  applyEntry,
  Journal,
  newJournalState,
  replayJournal,
  unresolvedOrders,
  type JournalEntry,
  type JournalOrder,
  type JournalState,
} from "./journal.ts";
import { minOrderSize, roundPriceForSide, roundSizeDown } from "./hl-rules.ts";
import { buildTopUpIntent, classifyMargin, marginRatioBps, type MarginBand } from "./margin.ts";
import { abs, BPS, btcToDecimal, min, notionalUsd6, priceToDecimal } from "./numbers.ts";
import { makerQuotePolicy, type QuotePolicy } from "./policy.ts";
import type { EventBus } from "./events.ts";
import type {
  AccountState,
  AquaOutlet,
  Clock,
  FillSource,
  HedgeStatus,
  HedgeVenue,
  ReferencePrice,
  ReferencePriceSource,
  Side,
} from "./types.ts";

export class HedgerGuardError extends Error {}

const BTC_PERP_MARKET = /^N?BTC-PERP$/;
const MAX_HEDGE_LEVERAGE = 5n;
const RECENT_ORDER_WINDOW_MS = 60_000;
const SHRINK_FLOOR_BPS = 1_000;

export interface ControllerConfig {
  market: string;
  enabled: boolean;
  deadband8: bigint;
  maxOrder8: bigint;
  priceBandBps: number;
  softLimitUsd6: bigint;
  hardLimitUsd6: bigint;
  referenceMaxAgeMs: number;
  confirmMaxAgeMs: number;
  blindAfterMs: number;
  unknownOrderGraceMs: number;
  leverageTarget: number;
  initialMakerPosition8: bigint;
  staleReadTolerance: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  urgentShrinkBps: number;
  intentCooldownMs: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  market: "NBTC-PERP",
  enabled: true,
  deadband8: 20_000n,
  maxOrder8: 50_000_000n,
  priceBandBps: 30,
  softLimitUsd6: 2_000_000_000n,
  hardLimitUsd6: 10_000_000_000n,
  referenceMaxAgeMs: 30_000,
  confirmMaxAgeMs: 30_000,
  blindAfterMs: 15_000,
  unknownOrderGraceMs: 10_000,
  leverageTarget: 4,
  initialMakerPosition8: 0n,
  staleReadTolerance: 3,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  urgentShrinkBps: 5_000,
  intentCooldownMs: 300_000,
};

export function assertBtcPerpMarket(market: string, venueCoin: string): void {
  if (!BTC_PERP_MARKET.test(market)) {
    throw new HedgerGuardError(`refusing to hedge ${market}: only a BTC perp market is supported`);
  }
  if (venueCoin !== "BTC") {
    throw new HedgerGuardError(`refusing to hedge on venue coin ${venueCoin}: only BTC is supported`);
  }
}

export interface ControllerDeps {
  venue: HedgeVenue;
  fillSource: FillSource;
  journal: Journal;
  bus: EventBus;
  config?: Partial<ControllerConfig>;
  aqua?: AquaOutlet;
  reference?: ReferencePriceSource;
  clock?: Clock;
  newCloid?: () => string;
  log?: (message: string) => void;
}

export interface TickReport {
  decision: string;
  status: HedgeStatus;
  orderCloid?: string;
  fillsProcessed: number;
}

interface PositionExpectation {
  expected8: bigint;
  positionBefore8: bigint;
  staleReads: number;
}

interface VenueRead {
  pos8: bigint;
  account: AccountState;
  at: number;
}

export function randomCloid(): string {
  return `0x${randomBytes(16).toString("hex")}`;
}

export class HedgeController {
  readonly config: ControllerConfig;
  private readonly venue: HedgeVenue;
  private readonly fillSource: FillSource;
  private readonly journal: Journal;
  private readonly bus: EventBus;
  private readonly aqua: AquaOutlet;
  private readonly reference: ReferencePriceSource | undefined;
  private readonly clock: Clock;
  private readonly newCloid: () => string;
  private readonly log: (message: string) => void;

  private state: JournalState = newJournalState();
  private makerPos8: bigint;
  private lastVenue: VenueRead | null = null;
  private lastReference: ReferencePrice | null = null;
  private lastAqua8 = 0n;
  private lastConfirmedAt: number | null = null;
  private lastFillPollOkAt: number | null = null;
  private expectation: PositionExpectation | null = null;
  private backoffUntil = 0;
  private backoffMs = 0;
  private rejectFactorBps = 10_000;
  private pendingFillIds: string[] = [];
  private manualHalt: string | null = null;
  private lastBand: MarginBand = "ok";
  private lastIntentAt = 0;
  private aquaBandActive = false;
  private lastExposureKey = "";
  private chain: Promise<unknown> = Promise.resolve();
  private started = false;
  private current: StatusSnapshot;
  rejectedForeignFills = 0;

  constructor(deps: ControllerDeps) {
    this.config = { ...DEFAULT_CONTROLLER_CONFIG, ...deps.config };
    assertBtcPerpMarket(this.config.market, deps.venue.spec.coin);
    this.venue = deps.venue;
    this.fillSource = deps.fillSource;
    this.journal = deps.journal;
    this.bus = deps.bus;
    this.aqua = deps.aqua ?? new NoopAquaOutlet();
    this.reference = deps.reference;
    this.clock = deps.clock ?? (() => Date.now());
    this.newCloid = deps.newCloid ?? randomCloid;
    this.log = deps.log ?? (() => {});
    this.makerPos8 = this.config.initialMakerPosition8;
    this.current = this.emptySnapshot("blind");
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.started) return;
      this.started = true;
      this.state = replayJournal(this.journal.entries());
      this.makerPos8 = this.config.initialMakerPosition8;
      for (const fill of this.state.fills.values()) this.makerPos8 += signedFillSize(fill);
      await this.reconcileUnresolved(this.clock());
    });
  }

  tick(): Promise<TickReport> {
    return this.serialize(() => this.runTick());
  }

  halt(reason: string): void {
    this.manualHalt = reason;
  }

  resume(): void {
    this.manualHalt = null;
  }

  snapshot(): StatusSnapshot {
    return this.current;
  }

  get makerPosition8(): bigint {
    return this.makerPos8;
  }

  get unresolvedCloids(): string[] {
    return unresolvedOrders(this.state).map((order) => order.cloid);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  private async runTick(): Promise<TickReport> {
    if (!this.started) {
      this.started = true;
      this.state = replayJournal(this.journal.entries());
      this.makerPos8 = this.config.initialMakerPosition8;
      for (const fill of this.state.fills.values()) this.makerPos8 += signedFillSize(fill);
    }
    const now = this.clock();

    const venueRead = await this.readVenue(now);
    const fillsProcessed = await this.ingestFills(now);
    const makerPos8 = this.makerPos8;
    const aqua8 = await this.readAqua();

    if (venueRead) await this.reconcileUnresolved(now);

    const position = this.resolvePosition(venueRead);
    const reference = await this.readReference(venueRead, now);
    const unhedged = this.assessExposure(position.pos8, makerPos8, aqua8, reference, now);

    const fresh = venueRead !== null;
    const noUnresolved = this.unresolvedCloids.length === 0;
    if (fresh && !unhedged.referenceExpired && noUnresolved && unhedged.notional6 < this.config.softLimitUsd6) {
      this.lastConfirmedAt = now;
    }

    if (venueRead) this.emitMarginIntent(venueRead.account, position.pos8, now);

    let decision = "hold:blind";
    let orderCloid: string | undefined;
    if (venueRead) {
      const outcome = await this.decide(venueRead, position, makerPos8, aqua8, now);
      decision = outcome.decision;
      orderCloid = outcome.cloid;
    }
    if (!this.config.enabled) decision = "hold:disabled";

    const status = this.computeStatus(now, unhedged);
    this.publishState({ status, position8: this.latestEffectivePosition(position.pos8), makerPos8, aqua8, unhedged, decision, now });
    return { decision, status, orderCloid, fillsProcessed };
  }

  private latestEffectivePosition(fallback: bigint): bigint {
    return this.expectation ? this.expectation.expected8 : fallback;
  }

  private async readVenue(now: number): Promise<VenueRead | null> {
    try {
      const pos8 = await this.venue.position();
      const account = await this.venue.accountState();
      this.lastVenue = { pos8, account, at: now };
      return this.lastVenue;
    } catch (error) {
      this.log(`venue read failed: ${String(error)}`);
      return null;
    }
  }

  private async ingestFills(now: number): Promise<number> {
    let processed = 0;
    try {
      const batch = await this.fillSource.poll();
      for (const fill of batch.fills) {
        if (this.acceptFill(fill, now)) processed += 1;
      }
      await this.fillSource.commit(batch.cursor);
      this.lastFillPollOkAt = now;
    } catch (error) {
      this.log(`fill source failed: ${String(error)}`);
    }
    return processed;
  }

  private acceptFill(fill: MakerFill, now: number): boolean {
    if (fill.market !== this.config.market) {
      this.rejectedForeignFills += 1;
      return false;
    }
    if (this.state.fills.has(fill.fillId)) return false;
    this.record({ type: "fill", t: now, fill });
    this.makerPos8 += signedFillSize(fill);
    this.pendingFillIds.push(fill.fillId);
    this.bus.publish({ kind: "fill", at: new Date(now).toISOString(), fill });
    return true;
  }

  private async readAqua(): Promise<bigint> {
    try {
      this.lastAqua8 = await this.aqua.inventory();
    } catch (error) {
      this.log(`aqua read failed: ${String(error)}`);
    }
    return this.lastAqua8;
  }

  private async readReference(venueRead: VenueRead | null, now: number): Promise<ReferencePrice | null> {
    if (this.reference) {
      try {
        this.lastReference = await this.reference.get();
      } catch (error) {
        this.log(`reference price failed: ${String(error)}`);
      }
    } else if (venueRead) {
      this.lastReference = { px8: venueRead.account.markPx8, at: now };
    }
    return this.lastReference;
  }

  private resolvePosition(venueRead: VenueRead | null): { pos8: bigint; confirmed: boolean } {
    if (!venueRead) return { pos8: this.lastVenue?.pos8 ?? 0n, confirmed: false };
    const expectation = this.expectation;
    if (!expectation) return { pos8: venueRead.pos8, confirmed: true };
    if (venueRead.pos8 === expectation.expected8) {
      this.expectation = null;
      return { pos8: venueRead.pos8, confirmed: true };
    }
    if (venueRead.pos8 === expectation.positionBefore8 && expectation.staleReads < this.config.staleReadTolerance) {
      expectation.staleReads += 1;
      return { pos8: expectation.expected8, confirmed: false };
    }
    this.expectation = null;
    return { pos8: venueRead.pos8, confirmed: true };
  }

  private assessExposure(
    pos8: bigint,
    makerPos8: bigint,
    aqua8: bigint,
    reference: ReferencePrice | null,
    now: number,
  ): Unhedged {
    const net8 = makerPos8 + pos8 + aqua8;
    const referenceExpired = !reference || now - reference.at > this.config.referenceMaxAgeMs;
    const notional6 = referenceExpired || !reference ? this.config.hardLimitUsd6 : notionalUsd6(net8, reference.px8);
    return { net8, notional6, referenceExpired };
  }

  private computeStatus(now: number, unhedged: Unhedged): HedgeStatus {
    if (this.manualHalt) return "halted";
    const blindFor = this.lastVenue ? now - this.lastVenue.at : Infinity;
    const fillBlind = this.lastFillPollOkAt === null || now - this.lastFillPollOkAt > this.config.blindAfterMs;
    if (blindFor > this.config.blindAfterMs || fillBlind) return "blind";
    if (unhedged.notional6 >= this.config.hardLimitUsd6) return "halted";
    if (this.lastConfirmedAt !== null && now - this.lastConfirmedAt <= this.config.confirmMaxAgeMs) return "hedged";
    return "lagging";
  }

  private async decide(
    venueRead: VenueRead,
    position: { pos8: bigint; confirmed: boolean },
    makerPos8: bigint,
    aqua8: bigint,
    now: number,
  ): Promise<{ decision: string; cloid?: string }> {
    if (!this.config.enabled) return { decision: "hold:disabled" };
    if (this.manualHalt) return { decision: "hold:halted" };
    if (this.unresolvedCloids.length > 0) return { decision: "hold:unresolved-order" };
    if (!position.confirmed) return { decision: "hold:awaiting-position-confirmation" };
    if (now < this.backoffUntil) return { decision: "hold:backoff" };

    const spec = this.venue.spec;
    const account = venueRead.account;
    const delta8 = -(makerPos8 + aqua8) - position.pos8;
    const side: Side = delta8 > 0n ? "buy" : "sell";
    const limitPx8 = this.limitPrice(account.markPx8, side);
    const minSize = minOrderSize(limitPx8, spec.szDecimals, spec.minNotional6);
    const threshold = this.config.deadband8 > minSize ? this.config.deadband8 : minSize;

    if (abs(delta8) < threshold) {
      await this.clearAquaBand();
      return { decision: "hold:within-deadband" };
    }

    const size8 = this.orderSize(abs(delta8), side, position.pos8, account);
    if (size8 < minSize) {
      await this.offerAqua(side, abs(delta8), account.markPx8, now);
      return { decision: "hold:margin-cap" };
    }

    const reduceOnly = isReduceOnly(side, size8, position.pos8);
    const cloid = await this.placeOrder({ side, size8, limitPx8, reduceOnly, positionBefore8: position.pos8, now });
    if (size8 < abs(delta8)) await this.offerAqua(side, abs(delta8) - size8, account.markPx8, now);
    return { decision: `order:${cloid}`, cloid };
  }

  private limitPrice(markPx8: bigint, side: Side): bigint {
    const band = BigInt(this.config.priceBandBps);
    const raw = side === "buy" ? (markPx8 * (BPS + band)) / BPS : (markPx8 * (BPS - band)) / BPS;
    return roundPriceForSide(raw, side, this.venue.spec.szDecimals);
  }

  private orderSize(wanted8: bigint, side: Side, pos8: bigint, account: AccountState): bigint {
    const factor = BigInt(Math.max(SHRINK_FLOOR_BPS, this.shrinkFactorBps(account)));
    const maxOrder = (this.config.maxOrder8 * factor) / BPS;
    const capped = min(wanted8, maxOrder);
    const reducing = reducingPortion(side, capped, pos8);
    const increasing = capped - reducing;
    const room8 = this.marginRoomSize8(pos8, account);
    const allowed = reducing + min(increasing, room8);
    return roundSizeDown(allowed, this.venue.spec.szDecimals);
  }

  private marginRoomSize8(pos8: bigint, account: AccountState): bigint {
    const maxNotional6 = account.accountValue6 * MAX_HEDGE_LEVERAGE;
    const current6 = notionalUsd6(pos8, account.markPx8);
    if (current6 >= maxNotional6) return 0n;
    return ((maxNotional6 - current6) * 10_000_000_000n) / account.markPx8;
  }

  private shrinkFactorBps(account: AccountState): number {
    const urgent = classifyMargin(marginRatioBps(account)) === "urgent";
    const margin = urgent ? this.config.urgentShrinkBps : 10_000;
    return Math.floor((margin * this.rejectFactorBps) / 10_000);
  }

  private async placeOrder(args: {
    side: Side;
    size8: bigint;
    limitPx8: bigint;
    reduceOnly: boolean;
    positionBefore8: bigint;
    now: number;
  }): Promise<string> {
    const cloid = this.freshCloid();
    const sourceFillIds = this.pendingFillIds.length > 0 ? [...this.pendingFillIds] : [];
    this.record({
      type: "intent",
      t: args.now,
      cloid,
      side: args.side,
      size8: args.size8.toString(),
      limitPx8: args.limitPx8.toString(),
      reduceOnly: args.reduceOnly,
      positionBefore8: args.positionBefore8.toString(),
      sourceFillIds,
    });
    this.publishOrder(cloid, "pending", args.now);

    try {
      const result = await this.venue.placeIoc({
        cloid,
        side: args.side,
        size8: args.size8,
        limitPx8: args.limitPx8,
        reduceOnly: args.reduceOnly,
      });
      this.record({
        type: "outcome",
        t: this.clock(),
        cloid,
        outcome: result.outcome,
        filled8: result.filled8.toString(),
        avgPx8: result.avgPx8?.toString(),
        reason: result.reason,
      });
      this.afterSettled(cloid, args.now);
      this.pendingFillIds = [];
      this.adjustBackoff(result.outcome, result.reason);
    } catch (error) {
      this.log(`placeIoc outcome unknown for ${cloid}: ${String(error)}`);
      this.record({ type: "unresolved", t: this.clock(), cloid, reason: `send-error: ${String(error)}` });
      this.publishOrder(cloid, "unresolved", this.clock());
      await this.attemptCancel(cloid);
      await this.reconcileOne(this.state.orders.get(cloid)!, this.clock());
      this.pendingFillIds = [];
    }
    return cloid;
  }

  private freshCloid(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const cloid = this.newCloid();
      if (!this.state.orders.has(cloid)) return cloid;
    }
    throw new Error("could not generate a unique cloid");
  }

  private adjustBackoff(outcome: string, reason: string | undefined): void {
    if (outcome === "filled" || outcome === "partial") {
      this.backoffMs = 0;
      this.backoffUntil = 0;
      this.rejectFactorBps = Math.min(10_000, this.rejectFactorBps * 2);
      return;
    }
    this.backoffMs = this.backoffMs === 0 ? this.config.backoffBaseMs : Math.min(this.backoffMs * 2, this.config.backoffMaxMs);
    this.backoffUntil = this.clock() + this.backoffMs;
    if (reason && /margin/i.test(reason)) {
      this.rejectFactorBps = Math.max(SHRINK_FLOOR_BPS, Math.floor(this.rejectFactorBps / 2));
    }
  }

  private async attemptCancel(cloid: string): Promise<boolean> {
    try {
      await this.venue.cancelByCloid(cloid);
      return true;
    } catch (error) {
      this.log(`cancel failed for ${cloid}: ${String(error)}`);
      return false;
    }
  }

  private async reconcileUnresolved(now: number): Promise<void> {
    for (const order of unresolvedOrders(this.state)) await this.reconcileOne(order, now);
  }

  private async reconcileOne(order: JournalOrder, now: number): Promise<void> {
    let status;
    try {
      status = await this.venue.orderStatusByCloid(order.cloid);
    } catch (error) {
      this.log(`status unavailable for ${order.cloid}: ${String(error)}`);
      return;
    }

    if (status.state === "filled" || status.state === "cancelled" || status.state === "rejected") {
      const final = settledFinal(status.state, status.filled8, order.size8);
      this.settle(order, final, status.filled8, status.avgPx8, now);
      return;
    }

    if (status.state === "open") {
      const cancelled = await this.attemptCancel(order.cloid);
      if (!cancelled) {
        this.record({ type: "unresolved", t: now, cloid: order.cloid, reason: "cancel-failed" });
        this.publishOrder(order.cloid, "unresolved", now);
        return;
      }
      const after = await this.venue.orderStatusByCloid(order.cloid).catch(() => null);
      if (after && after.state !== "open" && after.state !== "unknown") {
        this.settle(order, settledFinal(after.state, after.filled8, order.size8), after.filled8, after.avgPx8, now);
      }
      return;
    }

    const found = await this.findFillsByCloid(order);
    if (found !== null) {
      this.settle(order, found >= order.size8 ? "filled" : "partial", found, undefined, now);
      return;
    }
    if (now - order.intentAt >= this.config.unknownOrderGraceMs) {
      this.settle(order, "not-placed", 0n, undefined, now);
    }
  }

  private async findFillsByCloid(order: JournalOrder): Promise<bigint | null> {
    try {
      const fills = await this.venue.fillsSince(order.intentAt - 1_000);
      const matching = fills.filter((fill) => fill.cloid === order.cloid);
      if (matching.length === 0) return null;
      return matching.reduce((sum, fill) => sum + fill.size8, 0n);
    } catch {
      return null;
    }
  }

  private settle(
    order: JournalOrder,
    final: "filled" | "partial" | "cancelled" | "rejected" | "not-placed",
    filled8: bigint,
    avgPx8: bigint | undefined,
    now: number,
  ): void {
    this.record({
      type: "resolved",
      t: now,
      cloid: order.cloid,
      final,
      filled8: filled8.toString(),
      avgPx8: avgPx8?.toString(),
    });
    this.afterSettled(order.cloid, now);
  }

  private afterSettled(cloid: string, now: number): void {
    const order = this.state.orders.get(cloid);
    if (!order) return;
    if (order.filled8 > 0n && now - order.intentAt < RECENT_ORDER_WINDOW_MS) {
      const signed = order.side === "buy" ? order.filled8 : -order.filled8;
      this.expectation = {
        positionBefore8: order.positionBefore8,
        expected8: order.positionBefore8 + signed,
        staleReads: 0,
      };
    }
    this.publishOrder(cloid, orderStatusFor(order), now);
  }

  private record(entry: JournalEntry): void {
    this.journal.append(entry);
    applyEntry(this.state, entry);
  }

  private emitMarginIntent(account: AccountState, position8: bigint, now: number): void {
    const band = classifyMargin(marginRatioBps(account));
    const changed = band !== this.lastBand;
    this.lastBand = band;
    if (band === "ok") return;
    if (!changed && now - this.lastIntentAt < this.config.intentCooldownMs) return;
    const intent: TopUpIntent | null = buildTopUpIntent(account, position8, this.config.leverageTarget, now);
    if (!intent) return;
    this.lastIntentAt = now;
    this.bus.publish({ kind: "intent", at: new Date(now).toISOString(), intent });
  }

  private async offerAqua(side: Side, remaining8: bigint, markPx8: bigint, now: number): Promise<void> {
    const band = BigInt(this.config.priceBandBps);
    try {
      await this.aqua.setBand({
        direction: side,
        maxSize8: remaining8,
        minPx8: (markPx8 * (BPS - band)) / BPS,
        maxPx8: (markPx8 * (BPS + band)) / BPS,
        expiresAt: now + this.config.confirmMaxAgeMs,
      });
      this.aquaBandActive = true;
    } catch (error) {
      this.log(`aqua band failed: ${String(error)}`);
    }
  }

  private async clearAquaBand(): Promise<void> {
    if (!this.aquaBandActive) return;
    try {
      await this.aqua.setBand(null);
      this.aquaBandActive = false;
    } catch (error) {
      this.log(`aqua band clear failed: ${String(error)}`);
    }
  }

  private publishOrder(cloid: string, status: HedgeOrder["status"], now: number): void {
    const order = this.state.orders.get(cloid);
    if (!order) return;
    const event: HedgeOrder = {
      venue: "hyperliquid",
      cloid,
      coin: this.venue.spec.coin,
      assetIndex: this.venue.spec.assetIndex,
      reduceOnly: order.reduceOnly,
      tif: "Ioc",
      sourceFillIds: order.sourceFillIds.length > 0 ? order.sourceFillIds : ["rebalance"],
      side: order.side,
      size: order.size8.toString(),
      limitPrice: priceToDecimal(order.limitPx8),
      status,
      filledSize: order.filled8.toString(),
      avgPrice: order.avgPx8 ? priceToDecimal(order.avgPx8) : undefined,
      error: order.reason,
      createdAt: new Date(order.intentAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    this.bus.publish({ kind: "hedge", at: new Date(now).toISOString(), order: event });
  }

  private publishState(args: {
    status: HedgeStatus;
    position8: bigint;
    makerPos8: bigint;
    aqua8: bigint;
    unhedged: Unhedged;
    decision: string;
    now: number;
  }): void {
    const { status, position8, makerPos8, aqua8, unhedged, decision, now } = args;
    const net8 = makerPos8 + position8 + aqua8;
    const key = `${makerPos8}:${position8}:${aqua8}`;
    if (key !== this.lastExposureKey) {
      this.lastExposureKey = key;
      this.bus.publish({
        kind: "exposure",
        at: new Date(now).toISOString(),
        exposure: {
          market: this.config.market,
          makerPosition: makerPos8.toString(),
          hyperliquidPosition: position8.toString(),
          aquaInventory: aqua8.toString(),
          netResidual: net8.toString(),
          asOf: new Date(now).toISOString(),
        },
      });
    }
    const account = this.lastVenue?.account;
    const ratio = account ? marginRatioBps(account) : null;
    this.current = {
      status,
      quotePolicy: makerQuotePolicy(status, makerPos8),
      decision,
      hedgeEnabled: this.config.enabled,
      market: this.config.market,
      makerPosition: btcToDecimal(makerPos8),
      hyperliquidPosition: btcToDecimal(position8),
      aquaInventory: btcToDecimal(aqua8),
      netResidual: btcToDecimal(net8),
      unhedgedNotionalUsd6: unhedged.notional6.toString(),
      referenceExpired: unhedged.referenceExpired,
      unresolvedOrders: this.unresolvedCloids.length,
      awaitingPositionConfirmation: this.expectation !== null,
      marginRatioBps: ratio,
      marginBand: classifyMargin(ratio),
      lastVenueReadAt: this.lastVenue ? new Date(this.lastVenue.at).toISOString() : null,
      lastConfirmedAt: this.lastConfirmedAt === null ? null : new Date(this.lastConfirmedAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }

  private emptySnapshot(status: HedgeStatus): StatusSnapshot {
    return {
      status,
      quotePolicy: makerQuotePolicy(status, this.config.initialMakerPosition8),
      decision: "starting",
      hedgeEnabled: this.config.enabled,
      market: this.config.market,
      makerPosition: btcToDecimal(this.config.initialMakerPosition8),
      hyperliquidPosition: "0",
      aquaInventory: "0",
      netResidual: "0",
      unhedgedNotionalUsd6: "0",
      referenceExpired: true,
      unresolvedOrders: 0,
      awaitingPositionConfirmation: false,
      marginRatioBps: null,
      marginBand: "ok",
      lastVenueReadAt: null,
      lastConfirmedAt: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

export interface StatusSnapshot {
  status: HedgeStatus;
  quotePolicy: QuotePolicy;
  decision: string;
  hedgeEnabled: boolean;
  market: string;
  makerPosition: string;
  hyperliquidPosition: string;
  aquaInventory: string;
  netResidual: string;
  unhedgedNotionalUsd6: string;
  referenceExpired: boolean;
  unresolvedOrders: number;
  awaitingPositionConfirmation: boolean;
  marginRatioBps: number | null;
  marginBand: MarginBand;
  lastVenueReadAt: string | null;
  lastConfirmedAt: string | null;
  updatedAt: string;
}

interface Unhedged {
  net8: bigint;
  notional6: bigint;
  referenceExpired: boolean;
}

export function signedFillSize(fill: MakerFill): bigint {
  const size = BigInt(fill.size);
  return fill.makerSide === "buy" ? size : -size;
}

function reducingPortion(side: Side, size8: bigint, pos8: bigint): bigint {
  const opposes = (side === "buy" && pos8 < 0n) || (side === "sell" && pos8 > 0n);
  return opposes ? min(size8, abs(pos8)) : 0n;
}

function isReduceOnly(side: Side, size8: bigint, pos8: bigint): boolean {
  return pos8 !== 0n && reducingPortion(side, size8, pos8) === size8;
}

function settledFinal(
  state: "filled" | "cancelled" | "rejected",
  filled8: bigint,
  size8: bigint,
): "filled" | "partial" | "cancelled" | "rejected" {
  if (state === "rejected") return "rejected";
  if (filled8 >= size8) return "filled";
  if (filled8 > 0n) return "partial";
  return state === "filled" ? "filled" : "cancelled";
}

function orderStatusFor(order: JournalOrder): HedgeOrder["status"] {
  if (!order.settled) return "unresolved";
  switch (order.final) {
    case "filled":
      return "filled";
    case "partial":
      return "partial";
    case "rejected":
      return "rejected";
    default:
      return order.filled8 > 0n ? "partial" : "cancelled";
  }
}
