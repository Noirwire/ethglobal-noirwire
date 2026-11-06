import { CCTP_DOMAINS, SETTLED_TRANSFER_STATES, type BridgeTransfer, type TopUpIntent, type TransferRoute } from "@noirwire/shared";
import type { Hex } from "viem";
import type { Attester } from "./iris.ts";
import { decodeBurnBody, decodeMessage, messageHash } from "./message.ts";
import type { StateTimeouts, StepKey, TransferStore } from "./transfers.ts";
import type { StepLog, VaultPort } from "./vault.ts";

export const HYPERCORE_MAX_PER_TRANSFER = 1_000_000_000n;
const RELEASED_FROM_VAULT: ReadonlySet<TransferRoute> = new Set(["arc-hypercore"]);

export type DeliverResult =
  | { status: "done"; state: "minted" | "hook-executed" | "forwarded"; tx?: string }
  | { status: "pending"; reason: string };

export interface RouteAdapter {
  burn(transfer: BridgeTransfer): Promise<{ burnTx: string }>;
  messageFor(transfer: BridgeTransfer): Promise<Hex | undefined>;
  deliver(transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult>;
  hookOutcome?(transfer: BridgeTransfer): Promise<"vault-credited" | "claimable">;
  destinationBalance?(transfer: BridgeTransfer): Promise<bigint>;
}

export type TransferView = BridgeTransfer & { released?: boolean };

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

const DOMAINS: Record<TransferRoute, [number, number]> = {
  "arc-solana": [CCTP_DOMAINS.arc, CCTP_DOMAINS.solana],
  "solana-arc": [CCTP_DOMAINS.solana, CCTP_DOMAINS.arc],
  "arc-hypercore": [CCTP_DOMAINS.arc, CCTP_DOMAINS.hyperEvm],
  "hypercore-arc": [CCTP_DOMAINS.hyperEvm, CCTP_DOMAINS.arc],
};

export type StepResult = { changed: boolean; pending?: string };

export class TreasuryExecutor {
  private readonly pendingReasons = new Map<string, string>();
  private readonly advancing = new Set<string>();

  constructor(
    private readonly store: TransferStore,
    private readonly attester: Attester,
    private readonly adapters: Partial<Record<TransferRoute, RouteAdapter>>,
    private readonly config: ExecutorConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  submit(intent: TopUpIntent): BridgeTransfer[] {
    const existing = this.store.forIntent(intent.intentId);
    if (existing.length > 0) {
      const sameAmount = existing.reduce((sum, t) => sum + BigInt(t.grossAmount), 0n) === BigInt(intent.amount);
      if (!sameAmount || existing.some((t) => t.route !== intent.route)) {
        throw new IntentRejected(`intent ${intent.intentId} was already submitted with a different amount or route`);
      }
      return existing;
    }

    const policy = this.allowedRoute(intent.route);
    const total = BigInt(intent.amount);
    if (total <= 0n) throw new IntentRejected("amount must be positive");
    this.checkDailyCap(total);

    let cap = policy.perTransferCap ?? this.config.defaultPerTransferCap;
    if (intent.route === "arc-hypercore" && cap > HYPERCORE_MAX_PER_TRANSFER) cap = HYPERCORE_MAX_PER_TRANSFER;
    const [sourceDomain, destinationDomain] = DOMAINS[intent.route];
    const created: BridgeTransfer[] = [];
    let remaining = total;
    for (let index = 0; remaining > 0n; index++) {
      const chunk = remaining > cap ? cap : remaining;
      remaining -= chunk;
      created.push(
        this.store.create({
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
        }),
      );
    }
    return created;
  }

  view(transfer: BridgeTransfer): TransferView {
    if (!this.releasesFromVault(transfer)) return transfer;
    return { ...transfer, released: this.store.isReleased(transfer.transferId) };
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

  private checkDailyCap(amount: bigint): void {
    const today = this.now().toISOString().slice(0, 10);
    if (this.store.createdAmountOnDay(today) + amount > this.config.dailyCap) throw new IntentRejected("daily cap exceeded");
  }

  adoptBurn(input: { route: TransferRoute; burnTx: string; amount: bigint; beneficiary: string }): BridgeTransfer {
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
      maxFee: policy.maxFee.toString(),
      attester: this.attester.label,
      beneficiary: input.beneficiary,
      intentId: input.burnTx,
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
        if (this.returnsToVault(transfer)) return this.acknowledgeReturn(transfer);
        if (transfer.route !== "arc-solana") return { changed: false, pending: "minted with no next step on this route" };
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
    if (!this.store.canBurn(id)) {
      return { changed: false, pending: "burn outcome unknown, verify on chain before retrying" };
    }
    if (transfer.route === "arc-hypercore" && adapter.destinationBalance) {
      const ahead = this.store
        .inFlight()
        .some((t) => t.route === "arc-hypercore" && t.transferId !== id && t.state !== "requested");
      if (ahead) return { changed: false, pending: "waiting for the previous HyperCore transfer to credit" };
      const baseline = await adapter.destinationBalance(transfer);
      this.store.setMeta(id, { baselineBalance: baseline.toString() });
    }
    const vault = this.config.vault;
    if (vault && this.releasesFromVault(transfer)) {
      const released = await vault.release(
        this.stepLog(id, "release"),
        BigInt(transfer.grossAmount),
        this.store.stepTxHashes("release"),
      );
      if (released.status === "pending") return { changed: false, pending: released.reason };
      if (released.status === "refused") {
        const reason = `vault refused the release: ${released.reason}`;
        console.error(`transfer ${id} refused: ${reason}`);
        this.store.refuse(id, reason);
        return { changed: true };
      }
    }
    this.store.beginBurn(id);
    const { burnTx } = await adapter.burn(transfer);
    this.store.transition(id, "burned", { burnTx });
    return { changed: true };
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

  private async acknowledgeReturn(transfer: BridgeTransfer): Promise<StepResult> {
    const vault = this.config.vault as VaultPort;
    const amount =
      transfer.netMinted !== undefined ? BigInt(transfer.netMinted) : BigInt(transfer.grossAmount) - BigInt(transfer.maxFee);
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
      txHash: transfer.burnTx as string,
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
    const message = (await adapter.messageFor(transfer)) ?? (await this.messageFromAttester(transfer));
    const delivered = await adapter.deliver(transfer, message, transfer.attestation as Hex);
    if (delivered.status === "pending") return { changed: false, pending: delivered.reason };
    this.store.transition(transfer.transferId, delivered.state, { mintTx: delivered.tx });
    return { changed: true };
  }

  private async messageFromAttester(transfer: BridgeTransfer): Promise<Hex> {
    const result = await this.attester.fetchAttestation({
      sourceDomain: transfer.sourceDomain,
      txHash: transfer.burnTx as string,
    });
    if (!result.message) throw new Error("message bytes unavailable");
    return result.message;
  }

  private async confirmHyperCoreCredit(transfer: BridgeTransfer, adapter: RouteAdapter): Promise<StepResult> {
    if (!adapter.destinationBalance) return { changed: false, pending: "no HyperCore balance reader" };
    const baseline = this.store.meta(transfer.transferId)?.baselineBalance;
    if (baseline === undefined) return { changed: false, pending: "no baseline balance recorded" };
    const expected =
      transfer.netMinted !== undefined ? BigInt(transfer.netMinted) : BigInt(transfer.grossAmount) - BigInt(transfer.maxFee);
    const balance = await adapter.destinationBalance(transfer);
    if (balance - BigInt(baseline) < expected) {
      return { changed: false, pending: "forwarded, HyperCore balance has not risen yet" };
    }
    this.store.transition(transfer.transferId, "credited");
    return { changed: true };
  }
}
