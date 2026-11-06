import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  bridgeTransfer,
  SETTLED_TRANSFER_STATES,
  type BridgeTransfer,
  type TransferRoute,
  type TransferState,
} from "@noirwire/shared";

export type TransferMeta = {
  resumeState?: TransferState;
  burnAttempted?: boolean;
  baselineBalance?: string;
  createdAt: string;
  intentId?: string;
};

export type TransferRecord = { transfer: BridgeTransfer; meta: TransferMeta };

type JournalEntry = { seq: number; at: string; op: "create" | "update"; record: TransferRecord };

export type NewTransfer = {
  transferId: string;
  route: TransferRoute;
  sourceDomain: number;
  destinationDomain: number;
  grossAmount: string;
  maxFee: string;
  attester: BridgeTransfer["attester"];
  beneficiary?: string;
  closeId?: number;
  intentId?: string;
};

export type TransferPatch = Partial<
  Pick<
    BridgeTransfer,
    | "burnTx"
    | "messageHash"
    | "cctpNonce"
    | "attestation"
    | "mintTx"
    | "creditTx"
    | "feeExecuted"
    | "netMinted"
    | "error"
  >
>;

export class IllegalTransition extends Error {}

const NEXT: Record<TransferState, readonly TransferState[]> = {
  requested: ["burned", "stuck", "failed"],
  burned: ["attested", "stuck", "failed"],
  attested: ["minted", "hook-executed", "forwarded", "stuck", "failed"],
  minted: ["hook-executed", "credited", "forwarded", "stuck", "failed"],
  "hook-executed": ["vault-credited", "claimable", "stuck", "failed"],
  forwarded: ["credited", "stuck", "failed"],
  stuck: ["failed"],
  "vault-credited": [],
  claimable: [],
  credited: [],
  failed: [],
};

const ROUTE_STATES: Record<TransferRoute, ReadonlySet<TransferState>> = {
  "solana-arc": new Set(["requested", "burned", "attested", "minted", "hook-executed", "vault-credited", "claimable", "stuck", "failed"]),
  "arc-solana": new Set(["requested", "burned", "attested", "minted", "credited", "stuck", "failed"]),
  "arc-hypercore": new Set(["requested", "burned", "attested", "minted", "forwarded", "credited", "stuck", "failed"]),
  "hypercore-arc": new Set(["requested", "burned", "attested", "minted", "credited", "stuck", "failed"]),
};

export type StateTimeouts = Partial<Record<TransferState, number>>;

export class TransferStore {
  private readonly records = new Map<string, TransferRecord>();
  private readonly byMessageHash = new Map<string, string>();
  private readonly listeners = new Set<(transfer: BridgeTransfer) => void>();
  private seq = 0;

  constructor(
    private readonly journalPath?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (journalPath) this.replay(journalPath);
  }

  onChange(listener: (transfer: BridgeTransfer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(input: NewTransfer): BridgeTransfer {
    const existing = this.records.get(input.transferId);
    if (existing) return existing.transfer;
    const at = this.now().toISOString();
    const transfer = bridgeTransfer.parse({
      transferId: input.transferId,
      route: input.route,
      sourceDomain: input.sourceDomain,
      destinationDomain: input.destinationDomain,
      grossAmount: input.grossAmount,
      maxFee: input.maxFee,
      beneficiary: input.beneficiary,
      state: "requested",
      attester: input.attester,
      closeId: input.closeId,
      updatedAt: at,
    });
    this.commit("create", { transfer, meta: { createdAt: at, intentId: input.intentId } });
    return transfer;
  }

  get(transferId: string): BridgeTransfer | undefined {
    return this.records.get(transferId)?.transfer;
  }

  meta(transferId: string): TransferMeta | undefined {
    return this.records.get(transferId)?.meta;
  }

  list(): BridgeTransfer[] {
    return [...this.records.values()].map((record) => record.transfer);
  }

  findByMessageHash(hash: string): BridgeTransfer | undefined {
    const id = this.byMessageHash.get(hash.toLowerCase());
    return id ? this.get(id) : undefined;
  }

  inFlight(): BridgeTransfer[] {
    const seen = new Map<string, BridgeTransfer>();
    for (const { transfer } of this.records.values()) {
      if (SETTLED_TRANSFER_STATES.has(transfer.state)) continue;
      seen.set(transfer.messageHash?.toLowerCase() ?? transfer.transferId, transfer);
    }
    return [...seen.values()];
  }

  createdAmountOnDay(day: string): bigint {
    let total = 0n;
    for (const { transfer, meta } of this.records.values()) {
      if (meta.createdAt.slice(0, 10) === day) total += BigInt(transfer.grossAmount);
    }
    return total;
  }

  setMeta(transferId: string, patch: Partial<TransferMeta>): void {
    const record = this.require(transferId);
    this.commit("update", {
      transfer: record.transfer,
      meta: { ...record.meta, ...patch },
    });
  }

  canBurn(transferId: string): boolean {
    const record = this.require(transferId);
    return record.transfer.state === "requested" && !record.transfer.burnTx && !record.meta.burnAttempted;
  }

  beginBurn(transferId: string): void {
    if (!this.canBurn(transferId)) throw new IllegalTransition(`${transferId} may not be burned again`);
    this.setMeta(transferId, { burnAttempted: true });
  }

  transition(transferId: string, to: TransferState, patch: TransferPatch = {}): BridgeTransfer {
    const record = this.require(transferId);
    const { transfer } = record;
    if (!NEXT[transfer.state].includes(to) || !ROUTE_STATES[transfer.route].has(to)) {
      throw new IllegalTransition(`${transferId}: ${transfer.state} -> ${to} is not legal on ${transfer.route}`);
    }
    this.guardPatch(transfer, to, patch);
    const next = bridgeTransfer.parse({
      ...transfer,
      ...definedOnly(patch),
      state: to,
      updatedAt: this.now().toISOString(),
    });
    const meta = { ...record.meta };
    if (to !== "stuck") delete meta.resumeState;
    this.commit("update", { transfer: next, meta });
    return next;
  }

  markStuck(transferId: string, reason: string): BridgeTransfer {
    const record = this.require(transferId);
    const from = record.transfer.state;
    const stuck = this.transition(transferId, "stuck", { error: reason });
    this.setMeta(transferId, { resumeState: from });
    return stuck;
  }

  resume(transferId: string): BridgeTransfer {
    const record = this.require(transferId);
    const { transfer, meta } = record;
    if (transfer.state !== "stuck" || !meta.resumeState) {
      throw new IllegalTransition(`${transferId} is not stuck`);
    }
    const next = bridgeTransfer.parse({
      ...transfer,
      state: meta.resumeState,
      error: undefined,
      updatedAt: this.now().toISOString(),
    });
    const { resumeState: _dropped, ...rest } = meta;
    this.commit("update", { transfer: next, meta: rest });
    return next;
  }

  expireStale(timeouts: StateTimeouts, defaultMs: number): BridgeTransfer[] {
    const nowMs = this.now().getTime();
    const moved: BridgeTransfer[] = [];
    for (const { transfer } of [...this.records.values()]) {
      if (SETTLED_TRANSFER_STATES.has(transfer.state) || transfer.state === "stuck") continue;
      const limit = timeouts[transfer.state] ?? defaultMs;
      if (nowMs - Date.parse(transfer.updatedAt) > limit) {
        moved.push(this.markStuck(transfer.transferId, `timed out in ${transfer.state}`));
      }
    }
    return moved;
  }

  private guardPatch(transfer: BridgeTransfer, to: TransferState, patch: TransferPatch): void {
    if (patch.burnTx && transfer.burnTx && patch.burnTx !== transfer.burnTx) {
      throw new IllegalTransition(`${transfer.transferId}: burn tx is immutable once set`);
    }
    if (to === "burned" && !(patch.burnTx ?? transfer.burnTx)) {
      throw new IllegalTransition(`${transfer.transferId}: burned needs a burn tx`);
    }
    if (to === "attested" && !((patch.messageHash ?? transfer.messageHash) && (patch.attestation ?? transfer.attestation))) {
      throw new IllegalTransition(`${transfer.transferId}: attested needs a message hash and attestation`);
    }
    const hash = patch.messageHash?.toLowerCase();
    if (hash) {
      const owner = this.byMessageHash.get(hash);
      if (owner && owner !== transfer.transferId) {
        throw new IllegalTransition(`${transfer.transferId}: message ${hash} already belongs to ${owner}`);
      }
    }
  }

  private require(transferId: string): TransferRecord {
    const record = this.records.get(transferId);
    if (!record) throw new Error(`unknown transfer ${transferId}`);
    return record;
  }

  private commit(op: JournalEntry["op"], record: TransferRecord): void {
    this.apply(record);
    const entry: JournalEntry = { seq: ++this.seq, at: this.now().toISOString(), op, record };
    if (this.journalPath) {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`);
    }
    for (const listener of this.listeners) listener(record.transfer);
  }

  private apply(record: TransferRecord): void {
    this.records.set(record.transfer.transferId, record);
    if (record.transfer.messageHash) {
      this.byMessageHash.set(record.transfer.messageHash.toLowerCase(), record.transfer.transferId);
    }
  }

  private replay(path: string): void {
    if (!existsSync(path)) return;
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        continue;
      }
      this.apply({ transfer: bridgeTransfer.parse(entry.record.transfer), meta: entry.record.meta });
      this.seq = Math.max(this.seq, entry.seq);
    }
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
