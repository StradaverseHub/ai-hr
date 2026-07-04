/**
 * Pure, DB-free break-time display formatter for the Attendance Policy shift summary table
 * (Configurable Multi-Shift Attendance Management). Kept out of core/roster.ts so the client-rendered
 * table cell and its unit test import it without dragging in the DB client.
 *
 * DISPLAY-HONESTY (not a calculation change): core/roster.ts lets breakPeriods and breakMinutes be set
 * independently (breakMinutes is the canonical scalar the OT / hours engine actually uses; breakPeriods is a
 * storage-only display blob — see core/roster.ts normalizeShiftInput). When both are present we show the
 * period windows but flag when their summed duration disagrees with breakMinutes, since breakMinutes is what
 * the hours math consumes. We never silently present the period span as authoritative.
 */
import type { BreakPeriod } from '../db/schema';

export type BreakDisplay = {
  /** "12:00–13:00, 15:00–15:15" (periods) or "60 min" (scalar fallback) or "No break". */
  text: string;
  /** Set only when breakPeriods are present AND their summed minutes ≠ breakMinutes. Value = the scalar
   *  (breakMinutes) the hours engine actually deducts, so the caller can surface both figures. */
  mismatchMinutes?: number;
};

const hhmm = (t: string): string => t.slice(0, 5); // "HH:MM:SS" | "HH:MM" → "HH:MM"

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const sumPeriodMinutes = (periods: BreakPeriod[]): number =>
  periods.reduce((acc, bp) => acc + (toMin(bp.end) - toMin(bp.start)), 0);

/**
 * Format the Break Time column for one shift.
 * @param breakPeriods the stored break windows (may be null/empty)
 * @param breakMinutes the canonical scalar the hours engine deducts
 */
export function formatBreakDisplay(
  breakPeriods: BreakPeriod[] | null | undefined,
  breakMinutes: number | null | undefined,
): BreakDisplay {
  const scalar = Math.trunc(breakMinutes ?? 0);
  if (breakPeriods && breakPeriods.length > 0) {
    const text = breakPeriods.map((bp) => `${hhmm(bp.start)}–${hhmm(bp.end)}`).join(', ');
    const summed = sumPeriodMinutes(breakPeriods);
    return summed === scalar ? { text } : { text, mismatchMinutes: scalar };
  }
  if (scalar > 0) return { text: `${scalar} min` };
  return { text: '' }; // caller renders its localized "No break" label for the empty case
}
