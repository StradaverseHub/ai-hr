/**
 * 67268d83 (r367) round one — WHICH DAYS the employee's Attendance Overview is allowed to ask for.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR LINES IN THE PAGE ─────────────────────────────────────────────
 * It closes a live hazard, so it has to be testable without a session. `attendanceForEmploymentRange`
 * carries a hard day-loop ceiling (`ATTENDANCE_RANGE_MAX_DAYS`, core/attendance.ts) and its behaviour past
 * that ceiling is to STOP — returning a short array that is indistinguishable from "you have no attendance
 * after that date". Every caller until now chose the range itself and none could reach the cliff; r367 puts
 * a Date From / Date To pair in an employee's hands, and `?from=2020-01-01&to=2026-12-31` is one edit of the
 * address bar away. A screen that issued that read would print 400 days and silently drop the rest.
 *
 * So the range is decided HERE, against the kernel's own published ceiling, and the page refuses rather
 * than truncating. The ceiling is passed IN rather than imported: this module stays pure (no db/client, the
 * same reason app/attendance/requests/sections.ts imports core/attendance-derive directly rather than the
 * pack facade), which is what lets test/attendance-overview-round1.test.ts drive every boundary with plain
 * strings — and the page passes the kernel's constant, so the two numbers cannot drift apart.
 *
 * PURE: no DB, no React, no `t`, no clock. `today` is an argument, because a date read from an instant goes
 * through `todayInKualaLumpur()` at the edge (CLAUDE.md §8) and a module that called `new Date()` itself
 * could not be tested at a fixed point.
 */

/** The address-bar shape both dates arrive in. Anything else is ignored in favour of the default. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** First day of the month a `YYYY-MM-DD` falls in — the Date From the screen opens on. */
export const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;

/**
 * Why the range cannot be read, or `null` when it can.
 *
 *  • `too_long`  — more calendar days than the kernel's loop will walk. REFUSED, never truncated.
 *  • `inverted`  — Date From is after Date To. The kernel answers an empty array for this, which the table
 *                  would render as "no attendance records in this range" — a true sentence about a range
 *                  the reader did not mean to ask for. Saying what is actually wrong is cheaper than
 *                  letting them conclude their record is empty.
 */
export type RangeRefusal = 'too_long' | 'inverted' | null;

export type ResolvedRange = {
  /** What the screen will show in the Date From box — the asked-for value, valid or refused. */
  from: string;
  /** What the screen will show in the Date To box. */
  to: string;
  /** Calendar days the range spans, both ends included; 0 when inverted. */
  days: number;
  refusal: RangeRefusal;
};

/**
 * Calendar days from `from` to `to`, BOTH ENDS INCLUDED — so a single day is 1, not 0.
 *
 * Counted in whole UTC days from the ISO date strings, never from a local instant: an attendance date is a
 * plain calendar date, and putting it through a zone is how a range silently gains or loses its last day.
 * An inverted range answers 0 rather than a negative count, because the caller's next question is "is this
 * within the ceiling?" and a negative number would answer yes.
 */
export function dayCountInclusive(from: string, to: string): number {
  if (from > to) return 0;
  const MS_DAY = 86_400_000;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / MS_DAY) + 1;
}

/**
 * Resolve the address bar's `?from=&to=` into the range the page will read, or the reason it will not.
 *
 * DEFAULTS: first of the current month → today, which is the plan's "opening on the current month up to
 * today" and the same default `/attendance/individual` already uses. A malformed or missing value falls
 * back to its default rather than to an error — a half-parsed link should open the ordinary view.
 *
 * The asked-for dates are returned even when the range is refused, so the filter boxes still hold what the
 * reader typed and they can fix one end instead of starting again.
 */
export function resolveMyAttendanceRange(
  sp: { from?: string; to?: string },
  today: string,
  maxDays: number,
): ResolvedRange {
  const from = sp.from && DATE_RE.test(sp.from) ? sp.from : firstOfMonth(today);
  const to = sp.to && DATE_RE.test(sp.to) ? sp.to : today;
  if (from > to) return { from, to, days: 0, refusal: 'inverted' };
  const days = dayCountInclusive(from, to);
  return { from, to, days, refusal: days > maxDays ? 'too_long' : null };
}
