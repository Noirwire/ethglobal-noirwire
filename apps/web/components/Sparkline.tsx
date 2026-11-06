import type { PublicBucket } from "@/lib/privacy";
import { axisRange8, residualState } from "@/lib/residual";

const WIDTH = 600;
const HEIGHT = 72;

export function sparklinePaths(buckets: PublicBucket[], band8: bigint) {
  const values = buckets.map((bucket) => (bucket.residual === null ? null : BigInt(bucket.residual)));
  const range = axisRange8(
    values.filter((value): value is bigint => value !== null),
    band8,
  );
  const y = (value: bigint) => HEIGHT / 2 - (Number((value * 10_000n) / range) / 10_000) * (HEIGHT / 2 - 2);
  const x = (index: number) => (buckets.length <= 1 ? 0 : (index / (buckets.length - 1)) * WIDTH);
  const inside: string[] = [];
  const outside: string[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const a = values[i - 1];
    const b = values[i];
    if (a == null || b == null) continue;
    const warn = residualState(a, band8) === "outside" || residualState(b, band8) === "outside";
    (warn ? outside : inside).push(`M${x(i - 1).toFixed(1)} ${y(a).toFixed(1)}L${x(i).toFixed(1)} ${y(b).toFixed(1)}`);
  }
  const bandY = (Number((band8 * 10_000n) / range) / 10_000) * (HEIGHT / 2 - 2);
  return { inside: inside.join(""), outside: outside.join(""), bandTop: HEIGHT / 2 - bandY, bandBottom: HEIGHT / 2 + bandY };
}

export function Sparkline({ buckets, band8 }: { buckets: PublicBucket[]; band8: bigint }) {
  const { inside, outside, bandTop, bandBottom } = sparklinePaths(buckets, band8);
  const hasData = inside !== "" || outside !== "" || buckets.some((bucket) => bucket.residual !== null);
  return (
    <figure>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[72px] w-full"
        role="img"
        aria-label="Residual BTC over the last 15 minutes in 10 second buckets"
      >
        <rect x="0" y={bandTop} width={WIDTH} height={bandBottom - bandTop} className="fill-surface-raised" />
        <line x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} className="stroke-line-strong" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {inside && <path d={inside} className="stroke-ink-strong fill-none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        {outside && <path d={outside} className="stroke-warning fill-none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption className="text-faint mt-2 flex justify-between text-label">
        <span>15 min ago</span>
        <span>{hasData ? "10 s buckets" : "no published exposure yet"}</span>
        <span>20 s ago</span>
      </figcaption>
    </figure>
  );
}
