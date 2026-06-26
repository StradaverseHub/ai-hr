'use client';

/**
 * Dependency-free SVG pie/donut chart (Reporting & Analytics). The canonical use is gender / marital
 * distributions the feedback names explicitly — a pie is not faithfully a grouped bar, so it is kept as
 * its own primitive. Stable `id` for export; explicit palette + system-font text for faithful raster.
 */
import { colorAt } from './palette';

export type PieDatum = { label: string; value: number };
export type PieChartProps = { id: string; data: PieDatum[]; height?: number; ariaLabel?: string };

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
const TAU = Math.PI * 2;

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}

export function PieChart({ id, data, height = 220, ariaLabel }: PieChartProps) {
  const H = height;
  const W = 640;
  const r = Math.min(H, 240) / 2 - 16;
  const cx = r + 24;
  const cy = H / 2;
  const total = data.reduce((s, d) => s + d.value, 0);

  let angle = -Math.PI / 2; // start at 12 o'clock
  const slices = data.map((d, i) => {
    const frac = total > 0 ? d.value / total : 0;
    const a0 = angle;
    const a1 = angle + frac * TAU;
    angle = a1;
    return { ...d, a0, a1, frac, color: colorAt(i) };
  });

  return (
    <svg
      id={id}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      style={{ fontFamily: FONT, color: 'var(--muted-foreground)' }}
    >
      {total === 0 ? (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={1} />
      ) : (
        slices.map((s) =>
          s.frac >= 0.999 ? (
            <circle key={s.label} cx={cx} cy={cy} r={r} fill={s.color}>
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          ) : (
            <path key={s.label} d={arcPath(cx, cy, r, s.a0, s.a1)} fill={s.color} stroke="var(--card)" strokeWidth={1}>
              <title>{`${s.label}: ${s.value} (${Math.round(s.frac * 100)}%)`}</title>
            </path>
          ),
        )
      )}

      {/* legend */}
      <g transform={`translate(${cx + r + 28}, ${cy - (slices.length * 18) / 2})`}>
        {slices.map((s, i) => (
          <g key={s.label} transform={`translate(0, ${i * 18})`}>
            <rect x={0} y={-9} width={11} height={11} rx={2} fill={s.color} />
            <text x={18} y={0} fontSize={11} fill="var(--foreground)">
              {s.label} · {s.value}
              {total > 0 ? ` (${Math.round(s.frac * 100)}%)` : ''}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
