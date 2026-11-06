import { randomBytes } from "node:crypto";
import type { HedgeOrder, MakerFill, TopUpIntent } from "@noirwire/shared";
import { NoopAquaOutlet } from "./aqua.ts";
import { toHedgeOrderEvent, orderStatusFor } from "./hedge-order-event.ts";
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
import { minOrderSize } from "./hl-rules.ts";
import { buildTopUpIntent, classifyMargin, marginRatioBps, type MarginBand } from "./margin.ts";
import { abs } from "./numbers.ts";
import {
  aquaBandFor,
  holdThreshold8,
  INITIAL_THROTTLE,
  isReduceOnly,
  limitPrice,
  sideForDelta,
  sizeOrder,
  throttleAfterPlacement,
  type Throttle,
} from "./order-sizing.ts";
import {
  expectationAfterFill,
  resolvePosition,
  signedFillSize,
  type PositionExpectation,
  type ResolvedPosition,
  type VenueRead,
} from "./position.ts";
import { attemptCancel, resolveOrder } from "./reconcile.ts";
import {
  assessExposure,
  buildSnapshot,
  computeStatus,
  initialSnapshot,
  isConfirmable,
  netExposure8,
  type StatusSnapshot,
  type Unhedged,
} from "./status.ts";
import type { EventBus } from "./events.ts";
import type {
  AquaOutlet,
  Clock,
  FillSource,
  HedgeStatus,
  HedgeVenue,
  ReferencePrice,
  ReferencePriceSource,
  Side,
} from "./types.ts";

export type { StatusSnapshot };

export class HedgerGuardError extends Error {}

const BTC_PERP_MARKET = /^N?BTC-PERP$/;
const CLOID_ATTEMPTS = 8;

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
  makerPositionMaxAgeMs: number;
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
  makerPositionMaxAgeMs: 15_000,
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

interface Decision {
  decision: string;
  cloid?: string;
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
  private makerBlind = false;
  private lastAqua8 = 0n;
  private lastConfirmedAt: number | null = null;
  private lastFillPollOkAt: number | null = null;
  private lastPositionObservedAt = 0;
  private expectation: PositionExpectation | null = null;
  private throttle: Throttle = INITIAL_THROTTLE;
  private pendingFillIds: string[] = [];
  private manualHalt: string | null = null;
  private lastBand: MarginBand = "ok";
  private lastIntentAt = 0;
  private aquaBandActive = false;
  private lastExposureKey = "";
  private chain: Promise<unknown> = Promise.resolve();
  private started = false;
  private current: StatusSnapshot;

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
    this.makerBlind = deps.fillSource.reportsPosition === true;
    this.current = initialSnapshot(this.config.market, this.config.enabled, this.config.initialMakerPosition8);
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.started) return;
      this.replayFromJournal();
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

  private replayFromJournal(): void {
    this.started = true;
    this.state = replayJournal(this.journal.entries());
    this.makerPos8 = this.config.initialMakerPosition8;
    if (this.fillSource.reportsPosition) return;
    for (const fill of this.state.fills.values()) this.makerPos8 += signedFillSize(fill);
  }

  private async runTick(): Promise<TickReport> {
    if (!this.started) this.replayFromJournal();
    const now = this.clock();

    const venueRead = await this.readVenue(now);
    const fillsProcessed = await this.ingestFills(now);
    const makerPos8 = this.makerPos8;
    const aqua8 = await this.readAqua();

    if (venueRead) await this.reconcileUnresolved(now);

    const resolved = resolvePosition(
      venueRead,
      this.lastVenue?.pos8 ?? 0n,
      this.expectation,
      this.config.staleReadTolerance,
    );
    this.expectation = resolved.expectation;
    const position = resolved.position;
    const reference = await this.readReference(venueRead, now);
    const unhedged = assessExposure(netExposure8(makerPos8, position.pos8, aqua8), reference, now, this.config);

    if (isConfirmable(unhedged, venueRead !== null, this.unresolvedCloids.length === 0, this.config.softLimitUsd6)) {
      this.lastConfirmedAt = now;
    }

    if (venueRead) this.emitMarginIntent(venueRead, position.pos8, now);

    let decision = "hold:blind";
    let orderCloid: string | undefined;
    if (venueRead) {
      const outcome = await this.decide(venueRead, position, makerPos8, aqua8, now);
      decision = outcome.decision;
      orderCloid = outcome.cloid;
    }
    if (!this.config.enabled) decision = "hold:disabled";

    const status = computeStatus(
      now,
      unhedged,
      {
        lastVenueReadAt: this.lastVenue?.at ?? null,
        lastFillPollOkAt: this.lastFillPollOkAt,
        lastConfirmedAt: this.lastConfirmedAt,
      },
      this.config,
      this.manualHalt,
    );
    this.publishState({ status, position8: this.expectation?.expected8 ?? position.pos8, makerPos8, aqua8, unhedged, decision, now });
    return { decision, status, orderCloid, fillsProcessed };
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
      if (batch.makerPosition8 !== undefined) {
        this.assertFreshPosition(batch.makerPositionObservedAtMs, now);
        this.makerPos8 = batch.makerPosition8;
        this.makerBlind = false;
      }
      for (const fill of batch.fills) {
        if (this.acceptFill(fill, now)) processed += 1;
      }
      await this.fillSource.commit(batch.cursor);
      this.lastFillPollOkAt = now;
    } catch (error) {
      if (this.fillSource.reportsPosition) this.makerBlind = true;
      this.log(`fill source failed: ${String(error)}`);
    }
    return processed;
  }

  private assertFreshPosition(observedAt: number | undefined, now: number): void {
    if (observedAt === undefined) return;
    if (now - observedAt > this.config.makerPositionMaxAgeMs) {
      throw new Error(`maker position observed ${now - observedAt} ms ago, over the max age`);
    }
    if (observedAt < this.lastPositionObservedAt) {
      throw new Error("maker position is older than the last accepted one");
    }
    this.lastPositionObservedAt = observedAt;
  }

  private acceptFill(fill: MakerFill, now: number): boolean {
    if (fill.market !== this.config.market) return false;
    if (this.state.fills.has(fill.fillId)) return false;
    this.record({ type: "fill", t: now, fill });
    if (!this.fillSource.reportsPosition) this.makerPos8 += signedFillSize(fill);
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

  private async decide(
    venueRead: VenueRead,
    position: ResolvedPosition,
    makerPos8: bigint,
    aqua8: bigint,
    now: number,
  ): Promise<Decision> {
    const blocked = this.holdReason(position, now);
    if (blocked) return { decision: blocked };

    const { spec } = this.venue;
    const { account } = venueRead;
    const delta8 = -(makerPos8 + aqua8) - position.pos8;
    const side = sideForDelta(delta8);
    const limitPx8 = limitPrice(account.markPx8, side, this.config.priceBandBps, spec.szDecimals);
    if (limitPx8 === null) return { decision: "hold:price-band" };
    const minSize = minOrderSize(limitPx8, spec.szDecimals, spec.minNotional6);

    if (abs(delta8) < holdThreshold8(this.config.deadband8, minSize)) {
      await this.clearAquaBand();
      return { decision: "hold:within-deadband" };
    }

    const size8 = sizeOrder({
      wanted8: abs(delta8),
      side,
      pos8: position.pos8,
      account,
      maxOrder8: this.config.maxOrder8,
      urgentShrinkBps: this.config.urgentShrinkBps,
      rejectFactorBps: this.throttle.rejectFactorBps,
      szDecimals: spec.szDecimals,
    });
    if (size8 < minSize) {
      await this.offerAqua(side, abs(delta8), account.markPx8, now);
      return { decision: "hold:margin-cap" };
    }

    const cloid = await this.placeOrder({
      side,
      size8,
      limitPx8,
      reduceOnly: isReduceOnly(side, size8, position.pos8),
      positionBefore8: position.pos8,
      now,
    });
    if (size8 < abs(delta8)) await this.offerAqua(side, abs(delta8) - size8, account.markPx8, now);
    return { decision: `order:${cloid}`, cloid };
  }

  private holdReason(position: ResolvedPosition, now: number): string | null {
    if (!this.config.enabled) return "hold:disabled";
    if (this.manualHalt) return "hold:halted";
    if (this.makerBlind) return "hold:maker-position-unknown";
    if (this.unresolvedCloids.length > 0) return "hold:unresolved-order";
    if (!position.confirmed) return "hold:awaiting-position-confirmation";
    if (now < this.throttle.backoffUntil) return "hold:backoff";
    return null;
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
    this.record({
      type: "intent",
      t: args.now,
      cloid,
      side: args.side,
      size8: args.size8.toString(),
      limitPx8: args.limitPx8.toString(),
      reduceOnly: args.reduceOnly,
      positionBefore8: args.positionBefore8.toString(),
      sourceFillIds: [...this.pendingFillIds],
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
      this.throttle = throttleAfterPlacement(this.throttle, result.outcome, result.reason, this.clock(), {
        baseMs: this.config.backoffBaseMs,
        maxMs: this.config.backoffMaxMs,
      });
    } catch (error) {
      this.log(`placeIoc outcome unknown for ${cloid}: ${String(error)}`);
      this.record({ type: "unresolved", t: this.clock(), cloid, reason: `send-error: ${String(error)}` });
      this.publishOrder(cloid, "unresolved", this.clock());
      await attemptCancel(this.venue, cloid, this.log);
      const order = this.state.orders.get(cloid);
      if (order) await this.reconcileOne(order, this.clock());
      this.pendingFillIds = [];
    }
    return cloid;
  }

  private freshCloid(): string {
    for (let attempt = 0; attempt < CLOID_ATTEMPTS; attempt += 1) {
      const cloid = this.newCloid();
      if (!this.state.orders.has(cloid)) return cloid;
    }
    throw new Error("could not generate a unique cloid");
  }

  private async reconcileUnresolved(now: number): Promise<void> {
    for (const order of unresolvedOrders(this.state)) await this.reconcileOne(order, now);
  }

  private async reconcileOne(order: JournalOrder, now: number): Promise<void> {
    const resolution = await resolveOrder(this.venue, order, now, this.config.unknownOrderGraceMs, this.log);
    if (resolution.kind === "settled") {
      this.record({
        type: "resolved",
        t: now,
        cloid: order.cloid,
        final: resolution.final,
        filled8: resolution.filled8.toString(),
        avgPx8: resolution.avgPx8?.toString(),
      });
      this.afterSettled(order.cloid, now);
    } else if (resolution.kind === "cancel-failed") {
      this.record({ type: "unresolved", t: now, cloid: order.cloid, reason: "cancel-failed" });
      this.publishOrder(order.cloid, "unresolved", now);
    }
  }

  private afterSettled(cloid: string, now: number): void {
    const order = this.state.orders.get(cloid);
    if (!order) return;
    this.expectation = expectationAfterFill(order, now) ?? this.expectation;
    this.publishOrder(cloid, orderStatusFor(order), now);
  }

  private record(entry: JournalEntry): void {
    this.journal.append(entry);
    applyEntry(this.state, entry);
  }

  private emitMarginIntent(venueRead: VenueRead, position8: bigint, now: number): void {
    const { account } = venueRead;
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
    try {
      await this.aqua.setBand(
        aquaBandFor(side, remaining8, markPx8, this.config.priceBandBps, now + this.config.confirmMaxAgeMs),
      );
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
    this.bus.publish({
      kind: "hedge",
      at: new Date(now).toISOString(),
      order: toHedgeOrderEvent(order, this.venue.spec, status, now),
    });
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
          netResidual: netExposure8(makerPos8, position8, aqua8).toString(),
          asOf: new Date(now).toISOString(),
        },
      });
    }
    this.current = buildSnapshot({
      status,
      decision,
      hedgeEnabled: this.config.enabled,
      market: this.config.market,
      makerPos8,
      position8,
      aqua8,
      unhedged,
      unresolvedOrders: this.unresolvedCloids.length,
      awaitingPositionConfirmation: this.expectation !== null,
      lastVenue: this.lastVenue,
      lastConfirmedAt: this.lastConfirmedAt,
      now,
    });
  }
}
