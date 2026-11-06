import type { StepStatus } from "@/lib/deposit/evm-source";

export interface TimelineRow {
  key: string;
  label: string;
  status: StepStatus;
  detail: { href: string | null; text: string } | null;
}

const MARK: Record<StepStatus, string> = {
  done: "border-ink-strong bg-ink-strong text-[color:var(--color-base)]",
  skipped: "border-line text-faint",
  active: "border-ink-strong text-ink-strong",
  waiting: "border-line text-faint",
};

export function Timeline({ rows }: { rows: TimelineRow[] }) {
  return (
    <ol className="border-line-subtle divide-line-subtle divide-y rounded-lg border" aria-label="Progress">
      {rows.map((row, index) => (
        <li key={row.key} className="flex items-center gap-3 px-3 py-2.5" aria-current={row.status === "active" ? "step" : undefined}>
          <span className={`tnum grid size-5 shrink-0 place-items-center rounded-full border text-[11px] ${MARK[row.status]}`}>
            {row.status === "done" ? "✓" : index + 1}
          </span>
          <span className={`text-body ${row.status === "waiting" ? "text-faint" : "text-ink-strong"}`}>{row.label}</span>
          <span className="text-faint ml-auto min-w-0 truncate text-right text-label">
            {row.detail ? (
              row.detail.href ? (
                <a href={row.detail.href} target="_blank" rel="noreferrer" className="tnum text-dim hover:text-ink-strong underline underline-offset-2">
                  {row.detail.text}
                </a>
              ) : (
                row.detail.text
              )
            ) : row.status === "active" ? (
              "In progress"
            ) : row.status === "skipped" ? (
              "Not needed"
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
