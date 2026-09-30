/**
 * r302 (board 6c9802c9) — the Annual Leave ring. Plain inline SVG, no chart dependency.
 *
 * WHAT THE ARCS ARE. Around the circle, in order: what has been TAKEN, what is PENDING approval, what is LEFT TO
 * USE — "You can apply for" in the current leave year, the year's remaining available for an earlier one — and,
 * muted, the part of the year's entitlement NOT EARNED YET when there is any.
 *
 * cac9a3a1 (r369) — THE BIG NUMBER IN THE MIDDLE IS THE AVAILABLE ARC'S OWN FIGURE. What this header said
 * before, quoted so the old rule is not reinstated: "The big number in the middle is the Balance, which is
 * not an arc." It was, and the card therefore printed two figures for one thing — the reporter read 11.50 in
 * the middle and 10.50 in the Available Balance row beside it. The caller now passes `remaining` and the green
 * arc's own label, so the centre, the arc and the legend row are one figure under one name.
 *
 * THE LEGEND IS THE RING (r302 fix pass, verifier defect 5). The legend used to carry a green "Balance 7.00" while
 * the green arc drew Balance − Pending, so Balance 7 / Pending 7 showed a green legend entry over no green arc at
 * all. Now `ringSegments` is the ONE list both are drawn from: each legend entry is labelled exactly as its arc
 * (the arc's own <title>) and shows exactly the arc's value; arc lengths are proportional to those values and
 * the values sum to the ring's total. test/r302fp-my-leave-fixpass.dom.test.tsx measures it.
 *
 * Every figure except Not earned yet is the card's own, verbatim (core/my-leave.ts, picked off
 * leaveEntitlementBreakdown / leaveTypeApplySummary). Not earned yet is the one figure the ring derives —
 * Entitlement less Earned so far, to 2dp — and it is printed beside its arc precisely so the arc is not an
 * unexplained number. The SVG also carries a one-sentence `aria-label` built by the caller.
 *
 * A NULL FIGURE DRAWS NO RING, AND NEITHER DOES A NEGATIVE ONE. When HR hides a figure from employees (ESS view)
 * its arc would disclose it by proportion; an overdrawn "You can apply for" cannot be drawn as a length. In both
 * cases the caller draws the ordinary card instead (see `ringDrawable`), which prints every figure in full.
 *
 * Server-safe: no hooks, no 'use client'. Rendered from the client dashboard island.
 */

export type RingFigures = {
  entitlement: number | null;
  earnedSoFar: number | null;
  taken: number | null;
  pending: number | null;
  balance: number | null;
  /** The third arc: You can apply for (current year) or the year's remaining available (an earlier year). */
  remaining: number | null;
};

export const RING_COLORS = {
  taken: '#6366f1',
  pending: '#f59e0b',
  available: '#22c55e',
  unearned: '#d6d7e0',
  track: '#eef0f6',
} as const;

export type RingSegmentKey = 'taken' | 'pending' | 'available' | 'unearned';
export type RingSegment = { key: RingSegmentKey; value: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The ring is drawn only when every figure is visible and no arc figure is negative. */
export function ringDrawable(f: RingFigures): boolean {
  if (f.entitlement == null || f.earnedSoFar == null || f.taken == null || f.pending == null || f.balance == null || f.remaining == null) {
    return false;
  }
  return [f.taken, f.pending, f.remaining].every((n) => Number.isFinite(n) && n >= 0);
}

/**
 * The arcs AND the legend, in drawing order: Taken, Pending, the available arc, then Not earned yet only when the
 * year's entitlement is not all earned. A zero entry is listed (the legend says 0.00) and draws no arc.
 */
export function ringSegments(f: RingFigures): RingSegment[] {
  if (!ringDrawable(f)) return [];
  const unearned = round2(f.entitlement! - f.earnedSoFar!);
  return [
    { key: 'taken', value: f.taken! },
    { key: 'pending', value: f.pending! },
    { key: 'available', value: f.remaining! },
    ...(unearned > 0 ? [{ key: 'unearned' as const, value: unearned }] : []),
  ];
}

export function LeaveBalanceRing({
  segments,
  label,
  centre,
  centreCaption,
  size = 168,
}: {
  /** `ringSegments` with each entry's legend label and printed value — the same list the legend renders. */
  segments: (RingSegment & { label: string; display: string })[];
  /** One sentence naming the figures, for screen readers (pre-formatted by the caller). */
  label: string;
  /** The available arc's own figure, pre-formatted — the same value its legend row prints (cac9a3a1). */
  centre: string;
  centreCaption: string;
  size?: number;
}) {
  const r = 42;
  const stroke = 11;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, s) => n + Math.max(0, s.value), 0);
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
              >
                <title>{`${s.label} ${s.display}`}</title>
              </circle>
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
