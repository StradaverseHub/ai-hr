'use client';

/**
 * Dependency-free SVG line chart (Reporting & Analytics). Also serves the "trend" view — trend == line,
 * so there is no separate Trend component. Multiple series (e.g. hires + leavers) overlay on one axis.
 * Stable `id` for export; explicit palette + system-font text for faithful raster.
 */
import { colorAt } from './palette';

export type LineSeries = { label: string; values: number[] };
export type LineChartProps = {
  id: string;
  labels: string[]; // x-axis tick labels (e.g. months)
  series: LineSeries[];
  height?: number;
  ariaLabel?: string;
};

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

export function LineChart({ id, labels, series, height = 220, ariaLabel }: LineChartProps) {
  const W = 640;
  const legendCount = series.length;
  const legendHeight = legendCount > 0 ? legendCount * 26 + 12 : 0;
  const H = Math.max(height, 260) + legendHeight;
  const padL = 56;
  const padR = 56;
  const padT = 28;
  const padB = 96 + legendHeight;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const allVals = series.flatMap((s) => s.values);
  const max = Math.max(1, ...allVals);
  const min = Math.min(0, ...allVals); // include 0 (and any negative net-change)
  const span = max - min || 1;
  const n = Math.max(1, labels.length);
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - ((v - min) / span) * plotH;
  const ticks = 4;

  return (
    <div className="overflow-x-auto"><svg
      id={id}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      style={{ minWidth: 480, fontFamily: FONT, color: 'var(--muted-foreground)' }}
    >
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const v = min + (span / ticks) * i;
        const yy = y(v);
        return (
          <g key={i}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize={16} fill="var(--muted-foreground)">
              {Math.round(v)}
            </text>
          </g>
        );
      })}

      {labels.map((lab, i) => (
        <text
          key={lab + i}
          x={x(i)}
          y={H - padB + 14}
          textAnchor="middle"
          fontSize={16}
          fill="var(--muted-foreground)"
          transform={labels.length > 6 ? `rotate(35 ${x(i)} ${H - padB + 14})` : undefined}
        >
          {lab}
        </text>
      ))}

      {series.map((s, si) => {
        const color = colorAt(si);
        const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ');
        return (
          <g key={s.label}>
            <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={color}>
                <title>{`${labels[i] ?? ''} · ${s.label}: ${v}`}</title>
              </circle>
            ))}
          </g>
        );
      })}

      {/* legend */}
      <g>
        {series.map((s, si) => (
          <g key={s.label} transform={`translate(${padL}, ${H - 12 - (legendCount - 1 - si) * 26})`}>
            <rect x={0} y={-8} width={10} height={10} rx={2} fill={colorAt(si)} />
            <text x={14} y={0} fontSize={16} fill="var(--muted-foreground)">
              {s.label}
            </text>
          </g>
        ))}
      </g>
    </svg></div>
  );
}
