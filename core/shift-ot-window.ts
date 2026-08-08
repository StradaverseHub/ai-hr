/**
 * cf21e554 STAGE 2 — the arithmetic of the shift's own Overtime Schedule (table shift_ot_window,
 * migration 0418). Pure and DB-free, kept out of core/attendance.ts and core/roster.ts for the same reason
 * core/shift-break-display.ts is: the engine, the shift service and the unit test all import it without one
 * of them dragging in the DB client, and the rule can be read on one screen.
 *
 * WHAT THIS OWNS: which clocked minutes count as workday overtime, per declared clock-time window, with
 * that window's own minimum, maximum and adjustment.
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN: rounding and pay. The engine hands the total straight to
 * applyOtRuleRows afterwards, so the attendance rule's band rounding and the statutory 1.5×/2×/3× cap keep
 * owning those exactly as they did before this table existed. Putting rounding here would give a shift a
 * second, invisible way to move a payslip.
 */

const MINS_PER_DAY = 1440;

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Place a time-of-day on the shift's own timeline. This is the SAME 12-hour rule core/attendance.ts uses to
 * anchor a punch (anchorToShift) — a time more than 12h before the shift start belongs to the next calendar
 * day — restated here rather than imported, because importing it would close a cycle between this module
 * and the engine and would drag the DB client into the unit test. The two must agree: the punch and the
 * window are compared against each other, so a window placed by a different rule would silently overlap the
 * wrong hours. Any change to one is a change to both.
 */
const anchorToShift = (minutes: number, shiftStartAbs: number): number =>
  minutes < shiftStartAbs - MINS_PER_DAY / 2 ? minutes + MINS_PER_DAY : minutes;

/** One declared overtime window, as stored (shift_ot_window). Times are 'HH:MM[:SS]'. */
export type ShiftOtWindowSpec = {
  label?: string | null;
  startTime: string;
  endTime: string;
  /** The window ENDS on the day after it starts. */
  endNextDay?: boolean;
  /** Below this many minutes the window yields nothing at all. Null ⇒ no minimum. */
  minMinutes?: number | null;
  /** The most this window will ever credit. Null ⇒ no maximum. */
  maxMinutes?: number | null;
  /** Once this window's overtime REACHES `adjustAfterMinutes`, add `adjustDeltaMinutes` (signed — the
   *  reporter's "0030-" against "0130" is after 90, delta −30). Both or neither. */
  adjustAfterMinutes?: number | null;
  adjustDeltaMinutes?: number | null;
};

/** What one window contributed, and why — the material the audit panel prints. */
export type ShiftOtWindowMatch = {
  label: string | null;
  /** The clocked minutes that fell inside the window, before its own minimum / maximum / adjustment. */
  rawMinutes: number;
  /** What the window finally credited. */
  minutes: number;
};

export type ShiftOtWindowResult = { total: number; rows: ShiftOtWindowMatch[] };

/**
 * The workday overtime a punch earns under a shift's declared OT windows.
 *
 * `punch` and `shiftStartAbs` are already on the shift's timeline (minutes from midnight of the attendance
 * date, so a cross-midnight shift's end sits past 1440) — the engine builds them once and passes them in.
 *
 * Per window, in this order, and the order is the rule:
 *   1. OVERLAP  — the minutes of the punch that fell inside the window. Nothing outside a declared window
 *                 counts, which is the whole point of the feature: overtime "by clock time such as
 *                 0500-0800 and 1700-2359" rather than by hours past normal.
 *   2. MINIMUM  — below it the window yields ZERO, not a partial figure. "Min.Hrs" on the reference grid is
 *                 a qualifying threshold, not a floor to round up to.
 *   3. MAXIMUM  — clamp. "Max.Hrs" is the most this window will ever credit.
 *   4. ADJUST   — once the (already clamped) figure REACHES the threshold, apply the signed delta, floored
 *                 at zero. The reporter's shift is literally named "WITH 0.5 OT HOUR ADJ": at 1h30 of
 *                 overtime, deduct 30 minutes.
 * Windows are independent and their credits add up; two windows that overlap each other would double-count
 * the shared minutes, which is why the write path (core/roster.ts replaceShiftOtWindows) refuses them.
 */
export function otMinutesFromWindows(
  windows: ShiftOtWindowSpec[],
  punch: { inAbs: number; outAbs: number },
  shiftStartAbs: number,
): ShiftOtWindowResult {
  const rows: ShiftOtWindowMatch[] = [];
  let total = 0;
  for (const w of windows) {
    const startAbs = anchorToShift(toMin(w.startTime), shiftStartAbs);
    const lengthMinutes = toMin(w.endTime) + (w.endNextDay ? MINS_PER_DAY : 0) - toMin(w.startTime);
    const endAbs = startAbs + lengthMinutes;
    const raw = Math.max(0, Math.min(punch.outAbs, endAbs) - Math.max(punch.inAbs, startAbs));
    let minutes = raw;
    if (w.minMinutes != null && minutes < w.minMinutes) minutes = 0;
    if (w.maxMinutes != null) minutes = Math.min(minutes, w.maxMinutes);
    if (w.adjustAfterMinutes != null && w.adjustDeltaMinutes != null && minutes >= w.adjustAfterMinutes) {
      minutes = Math.max(0, minutes + w.adjustDeltaMinutes);
    }
    rows.push({ label: w.label ?? null, rawMinutes: raw, minutes });
    total += minutes;
  }
  return { total, rows };
}

/** Display helper for the shift form / list: "05:00–08:00", "17:00–06:00 (next day)" is the caller's
 *  business — this returns only the two clock faces, trimmed of seconds, like shift-break-display.ts. */
export const otWindowClock = (w: { startTime: string; endTime: string }): string =>
  `${w.startTime.slice(0, 5)}–${w.endTime.slice(0, 5)}`;
