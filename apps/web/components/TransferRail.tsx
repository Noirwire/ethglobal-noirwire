import { formatClock } from "@/lib/format";
import { shortHash } from "@/lib/explorers";
import { STAGE_LABEL, type RailNode } from "@/lib/transfers";
import type { PublicTransfer } from "@/lib/view-types";

export interface NodeView {
  key: string;
  label: string;
  reached: boolean;
  tone: "normal" | "danger" | "warning";
  hash: string | null;
  href: string | null;
  at: string | null;
  note?: string;
}

function Node({ node }: { node: NodeView }) {
  const dot = node.tone === "danger" ? "border-danger bg-danger" : node.tone === "warning" ? "border-warning" : node.reached ? "border-ink-strong bg-ink-strong" : "border-line";
  const text = node.tone === "danger" ? "text-danger" : node.reached ? "text-ink-strong" : "text-faint";
  return (
    <li className="relative min-w-0 pt-5">
      <span className={`rail-node absolute left-0 top-0 size-3 rounded-full border-2 ${dot}`} aria-hidden />
      <p className={`rail-label text-body ${text}`}>
        {node.label}
        <span className="sr-only">{node.reached ? ", reached" : ", pending"}</span>
      </p>
      {node.hash &&
        (node.href ? (
          <a href={node.href} target="_blank" rel="noreferrer" className="tnum text-dim hover:text-ink-strong block truncate text-label underline underline-offset-2" title={node.hash}>
            {shortHash(node.hash)}
          </a>
        ) : (
          <span className="tnum text-faint block truncate text-label" title={node.hash}>
            {shortHash(node.hash)}
          </span>
        ))}
      {node.at && (
        <time className="tnum text-faint block text-label" dateTime={node.at} title={node.at}>
          {formatClock(node.at)}
        </time>
      )}
      {node.note && <span className="text-faint block text-label">{node.note}</span>}
    </li>
  );
}

export function Rail({ nodes }: { nodes: NodeView[] }) {
  return (
    <div className="relative">
      <div className="bg-line absolute left-1.5 right-1.5 top-[5px] h-px" aria-hidden />
      <ol className="relative grid gap-3" style={{ gridTemplateColumns: `repeat(${nodes.length}, minmax(0, 1fr))` }}>
        {nodes.map((node) => (
          <Node key={node.key} node={node} />
        ))}
      </ol>
    </div>
  );
}

export function transferNodes(transfer: PublicTransfer): NodeView[] {
  const failedAt = transfer.rail.terminal?.kind === "failed" ? transfer.rail.nodes.findIndex((node) => !node.reached) : -1;
  return transfer.rail.nodes.map((node: RailNode, index): NodeView => {
    if (index === failedAt) {
      return {
        key: "failed",
        label: "Failed",
        reached: true,
        tone: "danger",
        hash: node.hash,
        href: node.href,
        at: transfer.updatedAt,
        note: transfer.rail.terminal?.error ?? undefined,
      };
    }
    return {
      key: node.stage,
      label: STAGE_LABEL[node.stage],
      reached: node.reached,
      tone: node.stalled ? "warning" : "normal",
      hash: node.hash,
      href: node.href,
      at: node.at,
      note: node.stalled ? "stalled" : undefined,
    };
  });
}
