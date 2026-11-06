import type { BridgeTransfer, TransferRoute, TransferState } from "@noirwire/shared";
import { txUrl, type Chain } from "./explorers";
import { PUBLISH_DELAY_MS } from "./privacy";
import type { PublicTransfer } from "./view-types";

export type Stage = "burned" | "attested" | "minted" | "credited";

export const STAGES: readonly Stage[] = ["burned", "attested", "minted", "credited"];

export const STAGE_LABEL: Record<Stage, string> = {
  burned: "Burned",
  attested: "Attested",
  minted: "Minted",
  credited: "Credited",
};

export const ROUTE_CHAINS: Record<TransferRoute, { from: Chain; to: Chain }> = {
  "arc-solana": { from: "arc", to: "solana" },
  "solana-arc": { from: "solana", to: "arc" },
  "arc-hypercore": { from: "arc", to: "hypercore" },
  "hypercore-arc": { from: "hypercore", to: "arc" },
};

const STATE_STAGE: Record<TransferState, number> = {
  requested: 0,
  burned: 1,
  attested: 2,
  minted: 3,
  "hook-executed": 3,
  forwarded: 3,
  "vault-credited": 4,
  claimable: 4,
  credited: 4,
  stuck: -1,
  failed: -1,
};

export interface RailNode {
  stage: Stage;
  reached: boolean;
  stalled: boolean;
  hash: string | null;
  href: string | null;
  at: string | null;
}

export interface Rail {
  nodes: RailNode[];
  terminal: { kind: "failed" | "stuck"; error: string | null } | null;
}

export function reachedStages(transfer: BridgeTransfer): number {
  const fromState = STATE_STAGE[transfer.state];
  if (fromState >= 0) return fromState;
  if (transfer.creditTx) return 4;
  if (transfer.mintTx) return 3;
  if (transfer.attestation) return 2;
  if (transfer.burnTx) return 1;
  return 0;
}

function hashFor(transfer: BridgeTransfer, stage: Stage): { hash: string | null; chain: Chain | null } {
  const chains = ROUTE_CHAINS[transfer.route];
  switch (stage) {
    case "burned":
      return { hash: transfer.burnTx ?? null, chain: chains.from };
    case "attested":
      return { hash: transfer.messageHash ?? null, chain: null };
    case "minted":
      return { hash: transfer.mintTx ?? null, chain: chains.to };
    case "credited":
      return { hash: transfer.creditTx ?? null, chain: chains.to };
  }
}

const MINUTE_MS = 60_000;

function floorToMinute(iso: string): string {
  return new Date(Math.floor(Date.parse(iso) / MINUTE_MS) * MINUTE_MS).toISOString();
}

function errorLabel(transfer: BridgeTransfer, reached: number): string {
  if (transfer.state === "stuck") return reached <= 2 && !transfer.attestation ? "waiting for attestation" : "stalled";
  return /refund/i.test(transfer.error ?? "") ? "refunded" : "failed";
}

export function railFor(transfer: BridgeTransfer): Rail {
  const reached = reachedStages(transfer);
  const local = transfer.attester === "local-test-attester";
  const nodes = STAGES.map((stage, index): RailNode => {
    const { hash, chain } = hashFor(transfer, stage);
    const isReached = index < reached;
    return {
      stage,
      reached: isReached,
      stalled: transfer.state === "stuck" && index === reached,
      hash: isReached || hash ? hash : null,
      href: hash && chain && !local ? txUrl(chain, hash) : null,
      at: isReached && index === reached - 1 ? floorToMinute(transfer.updatedAt) : null,
    };
  });
  const terminal =
    transfer.state === "failed" || transfer.state === "stuck"
      ? { kind: transfer.state, error: errorLabel(transfer, reached) }
      : null;
  return { nodes, terminal };
}

export function publicTransfers(transfers: BridgeTransfer[], nowMs: number): PublicTransfer[] {
  return transfers
    .filter((transfer) => Date.parse(transfer.updatedAt) <= nowMs - PUBLISH_DELAY_MS)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((transfer) => ({
      id: transfer.transferId,
      route: transfer.route,
      state: transfer.state,
      gross: transfer.grossAmount,
      netMinted: transfer.netMinted ?? null,
      fee: transfer.feeExecuted ?? null,
      attester: transfer.attester,
      updatedAt: floorToMinute(transfer.updatedAt),
      rail: railFor(transfer),
    }));
}

export const ATTESTER_LABEL: Record<BridgeTransfer["attester"], string> = {
  "circle-iris": "Circle Iris",
  "local-test-attester": "Local test attester",
};
