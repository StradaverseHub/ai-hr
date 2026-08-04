/**
 * 7c834696 stage 1 — "Attendance Calculation Engine Enhancement": the PURE arithmetic that turns a rule's
 * stored-but-previously-inert settings into per-day figures.
 *
 * Everything here is a total function of its arguments: no DB, no clock, no tenant. That is deliberate —
 * the release gate for this item is "a rule with no bands and deductions off leaves every derived figure
 * byte-identical to today", and a gate like that is only worth anything if you can assert it directly on
 * the function rather than through a fixture. core/attendance.ts calls these once per derived day;
 * test/attendance-stage1-calc.test.ts exercises them with zero fixtures.
 *
 * THE ONE INVARIANT THAT OUTRANKS EVERYTHING ELSE HERE
 * ----------------------------------------------------
 * `attendance.ot_minutes` is the canonical overtime total. core/payroll.ts (the OT prefill and the weekly
 * cross-cycle read), core/reporting.ts and the TOIL register all read it, and none of them reads a single
 * figure produced by this file. `splitOtMinutes` therefore ALWAYS returns buckets summing to exactly the
 * minutes it was given. Categorising MOVES minutes between rate columns; it can never create or destroy
 * one. If you change anything in this file, that sum is the assertion to keep green.
 */
import type { DayType } from './attendance';
import type { ResolvedAttendanceRule, ResolvedOtRow } from './attendance-rule';

/** The per-rate overtime buckets stored on the attendance row. OVERTIME ONLY — the "OT 1.0" COLUMN on the
 *  Records screens is normal-within-schedule hours, which stays derived (worked − ot), never stored. */
export type OtSplit = {
  /** A band whose rate pattern is FLAT: attendance records the hours, payroll decides what they are worth. */
  flat: number;
  /** A configured rate of 0 — "record the hours but do not pay them". Exists so the buckets still sum. */
  ot00: number;
  ot10: number;
  ot15: number;
  ot20: number;
  ot30: number;
};
export type OtSplitBucket = keyof OtSplit;

export const emptyOtSplit = (): OtSplit => ({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 0 });
export const otSplitTotal = (s: OtSplit): number => s.flat + s.ot00 + s.ot10 + s.ot15 + s.ot20 + s.ot30;

/** The five standardized variable multipliers the rule editor offers, mapped to their bucket. */
const VARIABLE_BUCKETS: [number, OtSplitBucket][] = [
  [0, 'ot00'],
  [1.0, 'ot10'],
  [1.5, 'ot15'],
  [2.0, 'ot20'],
  [3.0, 'ot30'],
];

/**
 * Which bucket a band's minutes land in.
 *
 *  • FLAT pattern → the `flat` bucket, whatever the numeric rate says. The request is explicit: choosing
 *    Flat disables the rate selector and attendance reports only "Flat OT hours".
 *  • VARIABLE pattern → the bucket for its multiplier (0 / 1.0 / 1.5 / 2.0 / 3.0). A stored multiplier
 *    that is none of those (only reachable by a hand-written row — the editor offers the five) falls back
 *    to `flat` rather than being dropped, because dropping it would break the sum invariant.
 */
export function bucketForRate(ratePattern: 'flat' | 'variable', rate: number): OtSplitBucket {
  if (ratePattern !== 'variable') return 'flat';
  const hit = VARIABLE_BUCKETS.find(([r]) => Math.abs(r - rate) < 0.005);
  return hit ? hit[1] : 'flat';
}

/** The multiplier a band uses on a given day: a public holiday prefers the band's own PH rate when one is
 *  set, and falls back to the ordinary rate when it is not — which is exactly today's behaviour. */
export function rateForDay(row: ResolvedOtRow, dayType: DayType): number {
  if (dayType === 'holiday' && row.phRate != null) return row.phRate;
  return row.rate;
}

/**
 * Split a day's overtime minutes across the rate buckets.
 *
 * NO BANDS (the overwhelming majority of rules, and every rule that predates this release) reproduces the
 * routing core/attendance-derive.ts `otByRate` has always done at READ time — workday to 1.5, rest day to
 * 2.0, holiday to 3.0 — so storing the split changes nothing anybody sees. That equivalence is the release
 * gate, and it is asserted directly, not assumed.
 *
 * WITH BANDS the walk is PROGRESSIVE, as the request specifies: under "first 2 hours at 1.5, next hour at
 * 2.0" a three-hour day is 2 hours at 1.5 plus 1 hour at 2.0, not three hours dumped into one column.
 *
 * Band geometry. Validation (core/attendance-rule.ts normalizeInput) now enforces the request's rule that
 * every next `from` equals the previous `to` + 1 minute, so the band boundaries ARE the `to` values and a
 * band's capacity is `to − previous to`. That is the only reading of the reporter's own worked example
 * that reproduces it (0–120 then 121–180 must cover 120 then 60 minutes, not 121 then 60). `from` is used
 * for ordering and validation; `to ≤ from` still means an open-ended final band, as it always has.
 *
 * TWO DELIBERATE NON-BEHAVIOURS, both because they would MOVE MONEY and both flagged for the owner:
 *  1. Minutes beyond the final band keep the FINAL band's rate. The request says they "shall not be
 *     counted as OT" — but that would cut `ot_minutes`, which is the figure payroll pays from, downward
 *     and retroactively for anyone with a bounded table. Truncation is its own opt-in decision.
 *  2. Rounding is NOT touched here. It stays in applyOtRuleRows and still decides `ot_minutes`; this
 *     function splits whatever total came out of it. See applyOtRuleRows for the unresolved conflict
 *     between the request's two rounding examples.
 */
export function splitOtMinutes(
  otMinutes: number | null,
  dayType: DayType,
  rule: ResolvedAttendanceRule | null,
): OtSplit {
  const out = emptyOtSplit();
  const total = Math.max(0, Math.trunc(otMinutes ?? 0));
  if (total === 0) return out;

  const bands = rule?.otRows ?? [];
  if (bands.length === 0) {
    // Byte-identical to the pre-7c834696 read-time routing in core/attendance-derive.ts otByRate.
    if (dayType === 'holiday') out.ot30 = total;
    else if (dayType === 'rest_day') out.ot20 = total;
    else out.ot15 = total;
    return out;
  }

  // Ascending by `from`; an open-ended band (to ≤ from) can only be the last one it consumes into.
  const sorted = [...bands].sort((a, b) => a.fromMinutes - b.fromMinutes);
  const add = (row: ResolvedOtRow, minutes: number) => {
    if (minutes <= 0) return;
    out[bucketForRate(row.ratePattern, rateForDay(row, dayType))] += minutes;
  };

  let remaining = total;
  let cursor = Math.max(0, sorted[0].fromMinutes);
  // A table that does not start at 0 leaves the minutes below it unclassified. Validation refuses to SAVE
  // such a table, but a rule stored before this release may have one, and those minutes are real overtime
  // that must not vanish — they take the first band's rate.
  if (cursor > 0) {
    const head = Math.min(remaining, cursor);
    add(sorted[0], head);
    remaining -= head;
  }
  for (const row of sorted) {
    if (remaining <= 0) break;
    const openEnded = row.toMinutes <= row.fromMinutes;
    const capacity = openEnded ? remaining : Math.max(0, row.toMinutes - cursor);
    const take = Math.min(remaining, capacity);
    add(row, take);
    remaining -= take;
    cursor = openEnded ? cursor + take : Math.max(cursor, row.toMinutes);
  }
  // Past the final bounded band — see non-behaviour (1) above.
  if (remaining > 0) add(sorted[sorted.length - 1], remaining);
  return out;
}

/**
 * Minutes late, measured on the shift's own timeline (all three arguments are "minutes from midnight of
 * the attendance date", so a cross-midnight shift is handled by the caller's anchoring, not by a special
 * case here).
 *
 * Grace first: an arrival inside the grace window is not late at all. Once it IS late, "include grace in
 * lateness" decides where the count starts — from the scheduled start (include) or from the end of the
 * grace window (exclude). That is the request's rule verbatim.
 */
export function latenessMinutes(p: {
  checkInAbs: number;
  startAbs: number;
  graceMinutes: number;
  includeGrace: boolean;
}): number {
  const grace = Math.max(0, p.graceMinutes);
  const threshold = p.startAbs + grace;
  if (p.checkInAbs <= threshold) return 0;
  return Math.max(0, p.includeGrace ? p.checkInAbs - p.startAbs : p.checkInAbs - threshold);
}

/** Minutes left early. Mirror image of latenessMinutes, against the shift's end. */
export function earlyOutMinutes(p: {
  checkOutAbs: number;
  endAbs: number;
  graceMinutes: number;
  includeGrace: boolean;
}): number {
  const grace = Math.max(0, p.graceMinutes);
  const threshold = p.endAbs - grace;
  if (p.checkOutAbs >= threshold) return 0;
  return Math.max(0, p.includeGrace ? p.endAbs - p.checkOutAbs : threshold - p.checkOutAbs);
}

/**
 * The wage-deduction minutes a measured lateness / early-out earns: "every X minutes late, deduct Y
 * minutes", floored — 25 minutes late under "every 15 → deduct 30" is one whole block, i.e. 30, not 50.
 * The request states there is NO maximum, so none is imposed.
 *
 * Returns 0 whenever either side of the pair is unset, which is what every rule in the product looks like
 * today. This function cannot produce a deduction the caller did not already gate — see deductionsApplyOn.
 */
export function deductionMinutes(measured: number, everyMinutes: number, deductPerBlock: number): number {
  if (measured <= 0 || everyMinutes <= 0 || deductPerBlock <= 0) return 0;
  return Math.floor(measured / everyMinutes) * deductPerBlock;
}

/**
 * THE SAFETY GATE ON THE ONLY DOWNWARD-CAPABLE FIGURE IN STAGE 1.
 *
 * A deduction may be computed for a day only when the day's paired rule has the per-rule switch ON and the
 * attendance date is on or after that rule's `deductionsEffectiveFrom` — which the service stamps to
 * today-in-Kuala-Lumpur at the instant the switch flips on and never earlier. Both halves are required, and
 * a DB CHECK (migration 0394) makes "switched on with no start date" unrepresentable, so there is no path
 * — through the engine, a re-derivation, or a correction re-approved months later — by which a closed
 * period acquires a deduction it did not have.
 */
export function deductionsApplyOn(rule: ResolvedAttendanceRule | null, attendanceDate: string): boolean {
  if (!rule?.applyDeductions) return false;
  if (!rule.deductionsEffectiveFrom) return false;
  return attendanceDate >= rule.deductionsEffectiveFrom; // ISO dates compare lexicographically
}
