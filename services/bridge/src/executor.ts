import { CCTP_DOMAINS, SETTLED_TRANSFER_STATES, type BridgeTransfer, type TopUpIntent, type TransferRoute } from "@noirwire/shared";
import type { Hex } from "viem";
import type { Attestation, Attester } from "./iris.ts";
import { decodeBurnBody, decodeMessage, messageHash } from "./message.ts";
import type { StateTimeouts, StepKey, TransferStore } from "./transfers.ts";
import type { StepLog, StepOutcome, VaultPort } from "./vault.ts";

export const HYPERCORE_MAX_PER_TRANSFER = 1_000_000_000n;
const RELEASED_FROM_VAULT: ReadonlySet<TransferRoute> = new Set(["arc-hypercore"]);
const SERIALIZED_ROUTES: ReadonlySet<TransferRoute> = new Set([
  "arc-hypercore",
  "hypercore-arc",
  "solana-hypercore",
  "hypercore-solana",
]);
export const DEPOSITOR_BURN_ROUTES: ReadonlySet<TransferRoute> = new Set(["ethereum-arc", "base-arc", "arbitrum-arc"]);
const CREDITED_ON_MINT: ReadonlySet<TransferRoute> = new Set(["arc-solana", "hypercore-solana"]);
export const REQUEST_EXPIRED_REASON = "the request expired before the transfer started";

export type DeliverResult =
  | { status: "done"; state: "minted" | "hook-executed" | "forwarded"; tx?: string }
  | { status: "pending"; reason: string };

export function forwarderDelivery(forward: Attestation["forward"], completed: "minted" | "forwarded"): DeliverResult {
  if (forward?.state === "COMPLETE") return { status: "done", state: completed, tx: forward.mintTxHash };
  if (forward?.state === "FAILED") return { status: "pending", reason: "Circle forwarder reported a failure" };
  return { status: "pending", reason: "waiting for the Circle forwarder" };
}

function expectedMint(transfer: BridgeTransfer): bigint {
  return transfer.netMinted !== undefined ? BigInt(transfer.netMinted) : BigInt(transfer.grossAmount) - BigInt(transfer.maxFee);
}

export type AdapterContext = { journal: StepLog };

export interface RouteAdapter {
  readonly idempotentBurn?: boolean;
  preflight?(transfer: BridgeTransfer): Promise<string | undefined>;
  burn(transfer: BridgeTransfer, context: AdapterContext): Promise<{ burnTx: string }>;
  attestationTxHash?(transfer: BridgeTransfer, context: AdapterContext): Promise<string>;
  messageFor(transfer: BridgeTransfer): Promise<Hex | undefined>;
  deliver(transfer: BridgeTransfer, message: Hex, attestation: Hex, context: AdapterContext): Promise<DeliverResult>;
  hookOutcome?(transfer: BridgeTransfer): Promise<"vault-credited" | "claimable">;
  destinationBalance?(transfer: BridgeTransfer): Promise<bigint>;
  creditedInLedger?(transfer: BridgeTransfer, expected: bigint, since: number): Promise<boolean>;
}

export type TransferView = BridgeTransfer & { released?: boolean; deposit?: boolean };

export type RoutePolicy = {
  destination: string;
  maxFee: bigint;
  perTransferCap?: bigint;
  beneficiary?: string;
};

export type ExecutorConfig = {
  routes: Partial<Record<TransferRoute, RoutePolicy>>;
  allowlist: ReadonlySet<string>;
  dailyCap: bigint;
  defaultPerTransferCap: bigint;
  stuckTimeoutMs: number;
  stateTimeouts?: StateTimeouts;
  stuckRetryMs: number;
  vault?: VaultPort;
};

export class IntentRejected extends Error {}
export class RouteUnavailable extends IntentRejected {}
export class IntentForbidden extends Error {}
export class BurnRefused extends Error {}

const DOMAINS: Record<TransferRoute, [number, number]> = {
  "arc-solana": [CCTP_DOMAINS.arc, CCTP_DOMAINS.solana],
  "solana-arc": [CCTP_DOMAINS.solana, CCTP_DOMAINS.arc],
  "ethereum-arc": [CCTP_DOMAINS.ethereum, CCTP_DOMAINS.arc],
  "base-arc": [CCTP_DOMAINS.base, CCTP_DOMAINS.arc],
  "arbitrum-arc": [CCTP_DOMAINS.arbitrum, CCTP_DOMAINS.arc],
  "arc-hypercore": [CCTP_DOMAINS.arc, CCTP_DOMAINS.hyperEvm],
  "hypercore-arc": [CCTP_DOMAINS.hyperEvm, CCTP_DOMAINS.arc],
  "solana-hypercore": [CCTP_DOMAINS.solana, CCTP_DOMAINS.hyperEvm],
  "hypercore-solana": [CCTP_DOMAINS.hyperEvm, CCTP_DOMAINS.solana],
};

export type StepResult = { changed: boolean; pending?: string };

export class TreasuryExecutor {
  private readonly pendingReasons = new Map<string, string>();
  private readonly advancing = new Set<string>();
  private hyperCoreHolder: string | undefined;
  private readonly reservations = new Map<string, { amount: bigint; until: number }>();

  constructor(
    private readonly store: TransferStore,
    private readonly attester: Attester,
    private readonly adapters: Partial<Record<TransferRoute, RouteAdapter>>,
    private readonly config: ExecutorConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  submitExternal(intent: TopUpIntent): BridgeTransfer[] {
    if (this.config.vault !== undefined && RELEASED_FROM_VAULT.has(intent.route)) {
      throw new IntentForbidden(`route ${intent.route} releases funds from the vault and accepts intents only from the onchain NavReceiver`);
    }
    return this.submit(intent);
  }

  submit(intent: TopUpIntent, options: { validUntil?: string } = {}): BridgeTransfer[] {
    const existing = this.store.forIntent(intent.intentId);
    if (existing.length > 0) {
      const sameAmount = existing.reduce((sum, t) => sum + BigInt(t.grossAmount), 0n) === BigInt(intent.amount);
      if (!sameAmount || existing.some((t) => t.route !== intent.route)) {
        throw new IntentRejected(`intent ${intent.intentId} was already submitted with a different amount or route`);
      }
      return existing;
    }

    if (DEPOSITOR_BURN_ROUTES.has(intent.route)) {
      throw new RouteUnavailable(`route ${intent.route} is burned by the depositor and takes no intents`);
    }
    const policy = this.allowedRoute(intent.route);
    const total = BigInt(intent.amount);
    if (total <= 0n) throw new IntentRejected("amount must be positive");
    this.checkDailyCap(total);

    let cap = policy.perTransferCap ?? this.config.defaultPerTransferCap;
    if (SERIALIZED_ROUTES.has(intent.route) && intent.route !== "hypercore-arc" && cap > HYPERCORE_MAX_PER_TRANSFER) {
      cap = HYPERCORE_MAX_PER_TRANSFER;
    }
    const [sourceDomain, destinationDomain] = DOMAINS[intent.route];
    const created: BridgeTransfer[] = [];
    let remaining = total;
    for (let index = 0; remaining > 0n; index++) {
      const chunk = remaining > cap ? cap : remaining;
      remaining -= chunk;
      const transfer = this.store.create({
        transferId: `${intent.intentId}:${index}`,
        route: intent.route,
        sourceDomain,
        destinationDomain,
        grossAmount: chunk.toString(),
        maxFee: policy.maxFee.toString(),
        attester: this.attester.label,
        beneficiary: policy.beneficiary,
        closeId: intent.closeId,
        intentId: intent.intentId,
      });
      const urgent = intent.reason === "margin-urgent";
      if (urgent || options.validUntil !== undefined) {
        this.store.setMeta(transfer.transferId, {
          ...(urgent ? { urgent } : {}),
          ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
        });
      }
      created.push(transfer);
    }
    return created;
  }

  view(transfer: BridgeTransfer): TransferView {
    const view: TransferView = this.store.meta(transfer.transferId)?.deposit ? { ...transfer, deposit: true } : { ...transfer };
    if (this.releasesFromVault(transfer)) view.released = this.store.isReleased(transfer.transferId);
    return view;
  }

  private releasesFromVault(transfer: BridgeTransfer): boolean {
    return this.config.vault !== undefined && RELEASED_FROM_VAULT.has(transfer.route);
  }

  recordRefused(intent: TopUpIntent, reason: string): BridgeTransfer {
    const existing = this.store.forIntent(intent.intentId)[0];
    if (existing) return existing;
    const transferId = `${intent.intentId}:0`;
    const [sourceDomain, destinationDomain] = DOMAINS[intent.route];
    this.store.create({
      transferId,
      route: intent.route,
      sourceDomain,
      destinationDomain,
      grossAmount: intent.amount,
      maxFee: "0",
      attester: this.attester.label,
      closeId: intent.closeId,
      intentId: intent.intentId,
    });
    return this.store.refuse(transferId, reason);
  }

  checkDeposit(route: TransferRoute, amount: bigint): void {
    const policy = this.allowedRoute(route);
    if (amount <= policy.maxFee) throw new IntentRejected(`amount must be above the ${policy.maxFee} base unit fee ceiling`);
    const cap = policy.perTransferCap ?? this.config.defaultPerTransferCap;
    if (amount > cap) throw new IntentRejected(`amount is above the per-transfer cap of ${cap} base units`);
    this.checkDailyCap(amount);
  }

  private allowedRoute(route: TransferRoute): RoutePolicy {
    const policy = this.config.routes[route];
    if (!policy || !this.adapters[route]) throw new RouteUnavailable(`route ${route} is not supported`);
    if (!this.config.allowlist.has(policy.destination.toLowerCase())) {
      throw new IntentRejected(`destination ${policy.destination} is not on the allowlist`);
    }
    return policy;
  }

  reserveCapacity(key: string, amount: bigint, until: Date): void {
    this.reservations.set(key, { amount, until: until.getTime() });
  }

  releaseCapacity(key: string): void {
    this.reservations.delete(key);
  }

  private reservedAmount(): bigint {
    const nowMs = this.now().getTime();
    let total = 0n;
    for (const { amount, until } of this.reservations.values()) if (until > nowMs) total += amount;
    return total;
  }

  private checkDailyCap(amount: bigint): void {
    const today = this.now().toISOString().slice(0, 10);
    if (this.store.createdAmountOnDay(today) + this.reservedAmount() + amount > this.config.dailyCap) {
      throw new IntentRejected("daily cap exceeded");
    }
  }

  adoptBurn(input: { route: TransferRoute; burnTx: string; amount: bigint; beneficiary: string; maxFee?: bigint }): BridgeTransfer {
    const transferId = `${input.burnTx}:0`;
    const existing = this.store.get(transferId);
    if (existing) return existing;
    const policy = this.config.routes[input.route];
    if (!policy) throw new IntentRejected(`route ${input.route} is not supported`);
    const [sourceDomain, destinationDomain] = DOMAINS[input.route];
    this.store.create({
      transferId,
      route: input.route,
      sourceDomain,
      destinationDomain,
      grossAmount: input.amount.toString(),
      maxFee: (input.maxFee ?? policy.maxFee).toString(),
      attester: this.attester.label,
      beneficiary: input.beneficiary,
      intentId: input.burnTx,
      deposit: true,
    });
    return this.store.transition(transferId, "burned", { burnTx: input.burnTx });
  }

  pending(): { transferId: string; reason: string }[] {
    return [...this.pendingReasons].map(([transferId, reason]) => ({ transferId, reason }));
  }

  async tick(): Promise<void> {
    this.store.expireStale(this.config.stateTimeouts ?? {}, this.config.stuckTimeoutMs);
    const nowMs = this.now().getTime();
    for (const transfer of this.store.list()) {
      if (transfer.state === "stuck" && nowMs - Date.parse(transfer.updatedAt) > this.config.stuckRetryMs) {
        this.store.resume(transfer.transferId);
      }
    }
    for (const transfer of this.store.inFlight()) {
      if (transfer.state !== "stuck") await this.advance(transfer.transferId);
    }
  }

  async advance(transferId: string): Promise<void> {
    if (this.advancing.has(transferId)) return;
    this.advancing.add(transferId);
    try {
      for (let guard = 0; guard < 8; guard++) {
        const result = await this.step(transferId);
        if (result.pending) this.pendingReasons.set(transferId, result.pending);
        else this.pendingReasons.delete(transferId);
        if (!result.changed) return;
        const state = this.store.get(transferId)?.state;
        if (!state || SETTLED_TRANSFER_STATES.has(state)) {
          this.pendingReasons.delete(transferId);
          return;
        }
      }
    } finally {
      this.advancing.delete(transferId);
    }
  }

  async step(transferId: string): Promise<StepResult> {
    const transfer = this.store.get(transferId);
    if (!transfer) throw new Error(`unknown transfer ${transferId}`);
    const adapter = this.adapters[transfer.route];
    if (!adapter) return { changed: false, pending: `no adapter for ${transfer.route}` };
    try {
      return await this.run(transfer, adapter);
    } catch (error) {
      return { changed: false, pending: error instanceof Error ? error.message : String(error) };
    }
  }

  private async run(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    const id = transfer.transferId;
    switch (transfer.state) {
      case "requested":
        return this.burn(transfer, adapter);
      case "burned":
        return this.attest(transfer, adapter);
      case "attested":
        return this.deliver(transfer, adapter);
      case "minted": {
        if (this.returnsToVault(transfer)) return this.acknowledgeReturn(transfer, adapter);
        if (!CREDITED_ON_MINT.has(transfer.route)) return { changed: false, pending: "minted with no next step on this route" };
        this.store.transition(id, "credited", { creditTx: transfer.mintTx });
        return { changed: true };
      }
      case "hook-executed": {
        if (!adapter.hookOutcome) return { changed: false, pending: "no hook outcome reader" };
        const outcome = await adapter.hookOutcome(transfer);
        this.store.transition(id, outcome);
        return { changed: true };
      }
      case "forwarded":
        return this.confirmHyperCoreCredit(transfer, adapter);
      default:
        return { changed: false };
    }
  }

  private async burn(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    const id = transfer.transferId;
    const validUntil = this.store.meta(id)?.validUntil;
    if (validUntil !== undefined && !this.burnArmed(id) && this.now().getTime() > Date.parse(validUntil)) {
      this.store.refuse(id, REQUEST_EXPIRED_REASON);
      return { changed: true };
    }
    if (!SERIALIZED_ROUTES.has(transfer.route)) return this.startBurn(transfer, adapter);
    if (this.hyperCoreHolder !== undefined && this.hyperCoreHolder !== id) {
      return { changed: false, pending: "waiting for the previous HyperCore transfer to settle" };
    }
    const armedAhead = this.store
      .inFlight()
      .some((t) => t.transferId !== id && SERIALIZED_ROUTES.has(t.route) && t.state === "requested" && this.burnArmed(t.transferId));
    if (armedAhead) return { changed: false, pending: "waiting for the previous HyperCore transfer to settle" };
    const urgentWaiting =
      this.store.meta(id)?.urgent !== true &&
      this.store.inFlight().some((t) => t.transferId !== id && t.state === "requested" && this.store.meta(t.transferId)?.urgent === true);
    if (urgentWaiting) return { changed: false, pending: "waiting for an urgent margin top-up to go first" };
    this.hyperCoreHolder = id;
    try {
      return await this.startBurn(transfer, adapter);
    } finally {
      this.hyperCoreHolder = undefined;
    }
  }

  private burnArmed(transferId: string): boolean {
    const meta = this.store.meta(transferId);
    const withdraw = meta?.withdraw;
    return meta?.burnAttempted === true || (withdraw !== undefined && withdraw.status !== "refused");
  }

  private async startBurn(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    const id = transfer.transferId;
    const resumable = adapter.idempotentBurn === true;
    if (!resumable && !this.store.canBurn(id)) {
      return { changed: false, pending: "burn outcome unknown, verify on chain before retrying" };
    }
    const concern = adapter.preflight ? await adapter.preflight(transfer) : undefined;
    if (concern) return { changed: false, pending: concern };
    if (SERIALIZED_ROUTES.has(transfer.route) && adapter.destinationBalance) {
      if (this.settledBehind(id)) return { changed: false, pending: "waiting for the previous HyperCore transfer to settle" };
      if (this.store.meta(id)?.baselineBalance === undefined) this.recordBaseline(id, await adapter.destinationBalance(transfer));
    }
    const vault = this.config.vault;
    if (vault && this.releasesFromVault(transfer)) {
      const refused = this.releaseSetback(
        id,
        await vault.release(this.stepLog(id, "release"), BigInt(transfer.grossAmount), this.store.stepTxHashes("release")),
      );
      if (refused) return refused;
    }
    return this.adapterBurn(transfer, adapter, resumable);
  }

  private settledBehind(id: string): boolean {
    return this.store.inFlight().some((t) => SERIALIZED_ROUTES.has(t.route) && t.transferId !== id && t.state !== "requested");
  }

  private recordBaseline(id: string, baseline: bigint): void {
    this.store.setMeta(id, { baselineBalance: baseline.toString(), burnStartedAt: this.now().toISOString() });
  }

  private releaseSetback(id: string, released: StepOutcome): StepResult | undefined {
    if (released.status === "pending") return { changed: false, pending: released.reason };
    if (released.status === "refused") {
      const reason = `vault refused the release: ${released.reason}`;
      console.error(`transfer ${id} refused: ${reason}`);
      this.store.refuse(id, reason);
      return { changed: true };
    }
    return undefined;
  }

  private async adapterBurn(transfer: BridgeTransfer, adapter: RouteAdapter, resumable: boolean): Promise<StepResult> {
    const id = transfer.transferId;
    if (!resumable) this.store.beginBurn(id);
    try {
      const { burnTx } = await adapter.burn(transfer, this.context(id));
      this.store.transition(id, "burned", { burnTx });
    } catch (error) {
      if (!(error instanceof BurnRefused)) throw error;
      console.error(`transfer ${id} refused: ${error.message}`);
      this.store.refuse(id, error.message);
    }
    return { changed: true };
  }

  private context(transferId: string): AdapterContext {
    return { journal: this.stepLog(transferId, "withdraw") };
  }

  private burnLookupTx(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<string> | string {
    return adapter.attestationTxHash ? adapter.attestationTxHash(transfer, this.context(transfer.transferId)) : (transfer.burnTx as string);
  }

  private stepLog(transferId: string, key: StepKey): StepLog {
    return {
      read: () => this.store.meta(transferId)?.[key],
      write: (record, durable) => this.store.setMeta(transferId, { [key]: record }, durable),
    };
  }

  private returnsToVault(transfer: BridgeTransfer): boolean {
    const vault = this.config.vault;
    const destination = this.config.routes[transfer.route]?.destination;
    return vault !== undefined && destination !== undefined && destination.toLowerCase() === vault.vault.toLowerCase();
  }

  private async acknowledgeReturn(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    const vault = this.config.vault as VaultPort;
    const amount = expectedMint(transfer);
    const baseline = this.store.meta(transfer.transferId)?.baselineBalance;
    if (adapter.destinationBalance && baseline !== undefined) {
      const risen = (await adapter.destinationBalance(transfer)) - BigInt(baseline);
      if (risen < amount) {
        return { changed: false, pending: `minted, but the vault USDC balance rose by ${risen} of the expected ${amount} base units` };
      }
    }
    const acknowledged = await vault.acknowledge(
      this.stepLog(transfer.transferId, "acknowledge"),
      amount,
      this.store.stepTxHashes("acknowledge"),
    );
    if (acknowledged.status === "done") {
      this.store.transition(transfer.transferId, "credited", { creditTx: acknowledged.txHash });
      return { changed: true };
    }
    return { changed: false, pending: acknowledged.status === "pending" ? acknowledged.reason : `vault refused the acknowledgement: ${acknowledged.reason}` };
  }

  private async attest(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    const message = await adapter.messageFor(transfer);
    const result = await this.attester.fetchAttestation({
      sourceDomain: transfer.sourceDomain,
      txHash: await this.burnLookupTx(transfer, adapter),
      message,
    });
    if (result.status !== "complete" || !result.message || !result.attestation) {
      return { changed: false, pending: "waiting for attestation" };
    }
    const header = decodeMessage(result.message);
    const body = decodeBurnBody(header.body);
    this.store.transition(transfer.transferId, "attested", {
      messageHash: messageHash(result.message),
      cctpNonce: header.nonce,
      attestation: result.attestation,
      feeExecuted: body.feeExecuted.toString(),
      netMinted: (body.amount - body.feeExecuted).toString(),
    });
    return { changed: true };
  }

  private async deliver(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    const message = (await adapter.messageFor(transfer)) ?? (await this.messageFromAttester(transfer, adapter));
    const delivered = await adapter.deliver(transfer, message, transfer.attestation as Hex, this.context(transfer.transferId));
    if (delivered.status === "pending") return { changed: false, pending: delivered.reason };
    this.store.transition(transfer.transferId, delivered.state, { mintTx: delivered.tx });
    return { changed: true };
  }

  private async messageFromAttester(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<Hex> {
    const result = await this.attester.fetchAttestation({
      sourceDomain: transfer.sourceDomain,
      txHash: await this.burnLookupTx(transfer, adapter),
    });
    if (!result.message) throw new Error("message bytes unavailable");
    return result.message;
  }

  private async confirmHyperCoreCredit(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    if (!adapter.destinationBalance) return { changed: false, pending: "no HyperCore balance reader" };
    const baseline = this.store.meta(transfer.transferId)?.baselineBalance;
    if (baseline === undefined) return { changed: false, pending: "no baseline balance recorded" };
    const expected = expectedMint(transfer);
    if (adapter.creditedInLedger) {
      const since = Date.parse(this.store.meta(transfer.transferId)?.burnStartedAt ?? "");
      if (Number.isNaN(since)) return { changed: false, pending: "no burn start time recorded" };
      if (await adapter.creditedInLedger(transfer, expected, since)) {
        this.store.transition(transfer.transferId, "credited");
        return { changed: true };
      }
      const risen = (await adapter.destinationBalance(transfer)) - BigInt(baseline) >= expected;
      return {
        changed: false,
        pending: risen
          ? "forwarded, the account value rose but no HyperCore ledger entry matches the credit yet"
          : "forwarded, no HyperCore ledger entry matches the credit yet",
      };
    }
    const balance = await adapter.destinationBalance(transfer);
    if (balance - BigInt(baseline) < expected) {
      return { changed: false, pending: "forwarded, HyperCore balance has not risen yet" };
    }
    this.store.transition(transfer.transferId, "credited");
    return { changed: true };
  }
}
