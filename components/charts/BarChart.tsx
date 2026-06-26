'use client';

/**
 * Dependency-free SVG bar chart (Reporting & Analytics, visual charts). Renders pure SVG with a stable
 * `id` so the export layer (lib/chart-export.ts) can grab the node. Themed via explicit palette hex +
 * a system-font stack on text (so PNG/PDF exports embed glyphs rather than garbling a web font).
 *
 * `grouped` mode draws several series side-by-side per category — this is how department-comparison
 * ships (no separate ComparisonBars component); a single-series chart passes one series.
 */
import { colorAt } from './palette';

export type BarSeries = { label: string; values: number[] };
export type BarChartProps = {
  id: string;
  categories: string[];
  /** One series per group bar. A simple chart passes a single series. */
  series: BarSeries[];
  /** When true and series.length > 1, draw grouped (side-by-side) bars per category. */
  grouped?: boolean;
  height?: number;
  ariaLabel?: string;
};

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

export function BarChart({ id, categories, series, grouped = false, height = 220, ariaLabel }: BarChartProps) {
  const W = 640;
  const H = height;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const seriesList = grouped ? series : series.slice(0, 1);
  const max = Math.max(1, ...seriesList.flatMap((s) => s.values));
  const n = Math.max(1, categories.length);
  const slot = plotW / n;
  const groupCount = seriesList.length;
  const barGap = 4;
  const barW = Math.max(2, (slot - barGap * 2) / groupCount - 2);

  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = 4;

  return (
    <svg
      id={id}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      style={{ fontFamily: FONT, color: 'var(--muted-foreground)' }}
    >
      {/* gridlines + y-axis ticks */}
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const v = (max / ticks) * i;
        const yy = y(v);
        return (
          <g key={i}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize={9} fill="var(--muted-foreground)">
              {Math.round(v)}
            </text>
          </g>
        );
      })}

      {/* bars */}
      {categories.map((cat, ci) => {
        const x0 = padL + ci * slot + barGap;
        return (
          <g key={cat}>
            {seriesList.map((s, si) => {
              const v = s.values[ci] ?? 0;
              const bx = x0 + si * (barW + 2);
              const by = y(v);
              return (
                <rect
                  key={s.label}
                  x={bx}
                  y={by}
                  width={barW}
                  height={Math.max(0, padT + plotH - by)}
                  rx={2}
                  fill={colorAt(grouped ? si : ci)}
                >
                  <title>{`${cat} · ${s.label}: ${v}`}</title>
                </rect>
              );
            })}
            <text
              x={x0 + (slot - barGap * 2) / 2}
              y={H - padB + 14}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted-foreground)"
              transform={categories.length > 6 ? `rotate(35 ${x0 + slot / 2} ${H - padB + 14})` : undefined}
            >
              {cat.length > 14 ? cat.slice(0, 13) + '…' : cat}
            </text>
          </g>
        );
      })}

      {/* legend (grouped only) */}
      {grouped && (
        <g>
          {seriesList.map((s, si) => (
            <g key={s.label} transform={`translate(${padL + si * 130}, ${H - 12})`}>
              <rect x={0} y={-8} width={10} height={10} rx={2} fill={colorAt(si)} />
              <text x={14} y={0} fontSize={9} fill="var(--muted-foreground)">
                {s.label}
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
