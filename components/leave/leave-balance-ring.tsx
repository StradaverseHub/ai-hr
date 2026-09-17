/**
 * r302 (board 6c9802c9) — the Annual Leave ring. Plain inline SVG, no chart dependency.
 *
 * WHAT THE ARCS ARE. Around the circle, in order: what has been TAKEN, what is PENDING approval, what REMAINS
 * of the balance once pending is set aside, and — muted — the part of the year's entitlement NOT EARNED YET.
 * Arc lengths are proportions only; no arc length is ever printed. Every number the employee reads comes from
 * the card's own figures (core/my-leave.ts, picked off leaveEntitlementBreakdown / leaveTypeApplySummary), and
 * the ring is decorative beside them: the legend that accompanies it IS the text equivalent, and the SVG also
 * carries a one-sentence `aria-label` built by the caller from those same printed figures.
 *
 * A NULL FIGURE DRAWS NO ARC. When HR hides a figure from employees (ESS view) its arc is absent rather than
 * reconstructed from the others — the caller does not draw the ring at all in that case (see
 * `ringDrawable`), because an arc proportion is itself a disclosure of the hidden number.
 *
 * Server-safe: no hooks, no 'use client'. Rendered from the client dashboard island.
 */

export type RingFigures = {
  entitlement: number | null;
  earnedSoFar: number | null;
  taken: number | null;
  pending: number | null;
  balance: number | null;
};

/** The ring is drawn only when every figure its arcs are proportioned from is visible. */
export function ringDrawable(f: RingFigures): boolean {
  return f.entitlement != null && f.earnedSoFar != null && f.taken != null && f.pending != null && f.balance != null;
}

export const RING_COLORS = {
  taken: '#6366f1',
  pending: '#f59e0b',
  remaining: '#22c55e',
  unearned: '#d6d7e0',
  track: '#eef0f6',
} as const;

export type RingSegment = { key: keyof typeof RING_COLORS; value: number };

/** The arc proportions, in drawing order. Negative inputs draw nothing (an overdrawn balance has no arc). */
export function ringSegments(f: RingFigures): RingSegment[] {
  if (!ringDrawable(f)) return [];
  const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return [
    { key: 'taken', value: pos(f.taken!) },
    { key: 'pending', value: pos(f.pending!) },
    { key: 'remaining', value: pos(f.balance! - Math.max(0, f.pending!)) },
    { key: 'unearned', value: pos(f.entitlement! - f.earnedSoFar!) },
  ];
}

export function LeaveBalanceRing({
  figures,
  label,
  centre,
  centreCaption,
  size = 168,
}: {
  figures: RingFigures;
  /** One sentence naming the figures, for screen readers (pre-formatted by the caller). */
  label: string;
  /** The printed Balance, pre-formatted. */
  centre: string;
  centreCaption: string;
  size?: number;
}) {
  const r = 42;
  const stroke = 11;
  const c = 2 * Math.PI * r;
  const segments = ringSegments(figures);
  const total = segments.reduce((n, s) => n + s.value, 0);
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} data-testid="leave-balance-ring">
      <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="50" cy="50" r={r} fill="none" stroke={RING_COLORS.track} strokeWidth={stroke} />
        {total > 0 &&
          segments.map((s) => {
            if (s.value <= 0) return null;
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.key}
                data-segment={s.key}
                cx="50"
                cy="50"
                r={r}
                fill="none"
                stroke={RING_COLORS[s.key]}
                strokeWidth={stroke}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 50 50)"
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-2xl font-bold tabular-nums leading-none">{centre}</span>
        <span className="mt-1 text-[11px] font-medium text-muted-foreground">{centreCaption}</span>
      </div>
    </div>
  );
}
