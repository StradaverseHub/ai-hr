/**
 * The Attendance Records number formatters, in ONE place.
 *
 * They used to be copy-pasted, identically, at the top of app/attendance/daily/page.tsx and
 * app/attendance/individual/page.tsx. 7c834696 point 3 adds a third reader — the calculation-breakdown
 * panel, which is a CLIENT island — and a panel that formatted minutes even slightly differently from the
 * cell it explains would be worse than no panel. So the two copies became this import, and the island uses
 * the same functions rather than a fourth copy.
 *
 * Plain module, no 'use client' / 'use server' directive: it is imported by server components AND by a
 * client island, and a directive here would forbid one of them.
 */

/** Durations rendered as "8h 05m" — Shift Hours and Actual Working Hours. NULL is an em dash, never "0h
 *  00m": no engine computed the day, which is a different claim from "worked nothing". */
export const fmtMin = (m: number | null | undefined) =>
  m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

/** OT columns render as decimal hours (2 dp), matching the request's example (0.50 / 1.00). */
export const fmtHours2 = (m: number) => (m / 60).toFixed(2);

/** Lateness / Early Out are small figures — "12m" reads better than "0h 12m". NULL stays an em dash: it
 *  means no engine computed the day, which is not at all the same claim as "on time". */
export const fmtShort = (m: number | null | undefined) =>
  m == null ? '—' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

/**
 * A CLOCK TIME, from "minutes since midnight of the attendance date" — the convention the whole trace uses
 * (core/attendance-trace.ts). This is NOT a second duration formatter: `fmtShort(1470)` is the duration
 * "24h 30m", while `fmtClock(1470)` is the instant "00:30 (+1)". Feeding a shift-anchored instant to a
 * duration formatter is exactly how a cross-midnight shift starts printing nonsense, so the two are
 * deliberately separate functions with names that cannot be confused at a call site.
 *
 * The "(+1)" suffix is the whole point of the anchored timeline: a 22:00 shift's 00:30 clock-out is
 * 1470 minutes from the attendance date's midnight, not 30, so it reads as after the shift start rather
 * than 21.5 hours before it. A negative day (a threshold that falls before the attendance date) prints
 * "(-1)" for the same reason.
 */
export const fmtClock = (abs: number) => {
  const day = Math.floor(abs / 1440);
  const within = ((abs % 1440) + 1440) % 1440;
  const hhmm = `${String(Math.floor(within / 60)).padStart(2, '0')}:${String(within % 60).padStart(2, '0')}`;
  return day === 0 ? hhmm : `${hhmm} (${day > 0 ? '+' : ''}${day})`;
};
