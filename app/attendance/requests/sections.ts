/**
 * 2166ef79 · My Attendance stage one — WHICH of the four sections a day belongs to, and what to prefill
 * into the request that fixes it.
 *
 * THE DETECTION IS NOT HERE, AND MUST NOT MOVE HERE. `flagOf` and `statusOf` (core/attendance-derive.ts)
 * already decide, for every day, whether a punch is missing, the arrival was late, the day finished short,
 * or the employee was absent — that is exactly the reporter's Incomplete Entry / Late In / Early Out /
 * Absent, and it has been running on the HR Individual Attendance screen since bbada39c. What was missing
 * was never the detection; it was that the EMPLOYEE was never shown it. So this module CALLS those two and
 * groups their answers. A second detection path would be the one way to make the employee's screen and
 * HR's disagree about the same day.
 *
 * PRECEDENCE IS flagOf's, UNCHANGED. `odd` sits ABOVE `late` in flagOf, so a day missing one punch is an
 * Incomplete Entry and does NOT also appear under Short Hours — lateness on a day you only have one end of
 * cannot be judged. (Verified on production: 2026-08-10 for employee 100814 carries both a missing
 * clock-out and 60 late minutes, and it belongs in Incomplete Entry.) A stored `absent` row is only
 * consulted after the flag, for the same reason: the flag describes punches that exist.
 *
 * PURE. No DB, no React, no `t` — imports only the derivation module, which is itself pure. That is what
 * lets the section rules be unit-tested with plain object literals and no fixtures, and it is why the
 * import is `core/attendance-derive` directly rather than the pack facade (which drags in db/client).
 * `app/attendance/` is pack surface, so the import ratchet allows it — the same import
 * app/attendance/individual/page.tsx already makes.
 */
import { flagOf, statusOf, type AttendanceFlag } from '@/core/attendance-derive';

/** The four sections the reporter asked for, plus `other` — the free-form "correct another day" route,
 *  which is not one of them and is why the stored kind has five values rather than four. */
export type AttendanceSection = 'overtime' | 'short' | 'incomplete' | 'absent';

/** The DB `request_kind` each section files under (db/schema ATTENDANCE_REQUEST_KINDS). */
export const KIND_OF_SECTION = {
  overtime: 'self_overtime',
  short: 'short_hours',
  incomplete: 'incomplete_entry',
  absent: 'absent',
} as const;

/**
 * The day shape this module reads — a structural SUBSET of core/attendance's AttendanceRangeRow, declared
 * here so a test can hand in a literal and so this file needs nothing from the DB layer.
 */
export type ExceptionDayInput = {
  date: string;
  attendanceId: string | null;
  status: string | null;
  context: 'on_leave' | 'holiday' | 'rest_day' | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  dayType: 'workday' | 'rest_day' | 'holiday' | null;
  workedMinutes: number | null;
  scheduledMinutes: number | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  isRosterRest: boolean;
};

/** One flagged day, ready to render and to prefill a request from. */
export type ExceptionDay = {
  date: string;
  section: Exclude<AttendanceSection, 'overtime'>;
  /** flagOf's own answer, carried through so the screen never restates the rule. */
  flag: AttendanceFlag;
  /** The scheduled window as HH:MM–HH:MM, or null on a day no shift resolves for. */
  scheduledFrom: string | null;
  scheduledTo: string | null;
  /** What we actually hold for the day (HH:MM), either side possibly missing. */
  actualIn: string | null;
  actualOut: string | null;
  /** Which punch is missing — Incomplete Entry only. */
  missing: 'in' | 'out' | null;
  /** Minutes late / minutes finished early. NULL is "we do not know", never a confident zero: 196 of 270
   *  production rows predate the engine that stores these, so a section keyed on the column alone would
   *  show almost nothing (which is why membership is keyed on the FLAG and only the duration on the
   *  column). */
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  /** What the Fix panel opens with. Never invents a clock-in it does not have on a missing-out day —
   *  requestAttendanceCorrection refuses a clock-out with no clock-in, because it has no anchor. */
  prefillIn: string | null;
  prefillOut: string | null;
};

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

/**
 * Classify ONE day. Returns null for a day with nothing wrong with it — which is most of them.
 *
 * `today` is excluded by the CALLER (it picks the range), not here: a day still being worked has no
 * clock-out yet and would read as an Incomplete Entry every morning.
 */
export function classifyDay(row: ExceptionDayInput): ExceptionDay | null {
  const flag = flagOf(row);
  const scheduledFrom = hhmm(row.shiftStart);
  const scheduledTo = hhmm(row.shiftEnd);
  const actualIn = hhmm(row.checkInAt);
  const actualOut = hhmm(row.checkOutAt);
  const base = {
    date: row.date,
    flag,
    scheduledFrom,
    scheduledTo,
    actualIn,
    actualOut,
    missing: null,
    lateMinutes: null,
    earlyOutMinutes: null,
  } as const;

  if (flag === 'odd') {
    const missing: 'in' | 'out' = actualIn == null ? 'in' : 'out';
    return {
      ...base,
      section: 'incomplete',
      missing,
      // The half we HOLD is carried into the form untouched (locked on screen); only the missing half is
      // proposed, from the scheduled window. On a missing clock-IN both ends must be sent, because the
      // service will not take a clock-out on its own.
      prefillIn: missing === 'in' ? scheduledFrom : actualIn,
      prefillOut: missing === 'out' ? scheduledTo : actualOut,
    };
  }

  if (flag === 'late' || flag === 'under') {
    // Prefer the STORED figures; fall back to the shortfall the flag itself measured. A `late` day whose
    // late_minutes is null keeps a null duration rather than a made-up one — the day is still listed,
    // because the engine did classify it, but the screen says the duration was not recorded.
    const earlyOutMinutes =
      row.earlyOutMinutes ??
      (flag === 'under' && row.scheduledMinutes != null && row.workedMinutes != null
        ? Math.max(0, row.scheduledMinutes - row.workedMinutes)
        : null);
    return {
      ...base,
      section: 'short',
      lateMinutes: row.lateMinutes,
      earlyOutMinutes,
      // Both ends are real here, so the form opens on what was actually clocked and the employee changes
      // the end that is wrong.
      prefillIn: actualIn,
      prefillOut: actualOut,
    };
  }

  // Only after the flag: statusOf's `absent` covers BOTH a stored absent row and a working day with no row
  // at all (0 rows are stored as 'absent' in production today, so in practice it is the second).
  if (statusOf(row) === 'absent') {
    return {
      ...base,
      section: 'absent',
      // Nothing was clocked, so the whole scheduled day is what gets proposed.
      prefillIn: scheduledFrom,
      prefillOut: scheduledTo,
    };
  }

  return null;
}

/** Every flagged day in the range, in date order, grouped by section. */
export function groupExceptions(rows: ExceptionDayInput[]): {
  incomplete: ExceptionDay[];
  short: ExceptionDay[];
  absent: ExceptionDay[];
} {
  const out = { incomplete: [] as ExceptionDay[], short: [] as ExceptionDay[], absent: [] as ExceptionDay[] };
  for (const row of rows) {
    const d = classifyDay(row);
    if (d) out[d.section].push(d);
  }
  return out;
}

/**
 * Which section to open on. The reporter's own principle — "employees should only see the records that
 * require their action" — so the screen opens on the first section that HAS something in it, in the order
 * a missing punch (which zeroes the whole day) matters most. Self Overtime is the fallback because it is
 * the one section that is never an exception: it is a thing you go and ask for.
 */
export function defaultSection(counts: { incomplete: number; short: number; absent: number }): AttendanceSection {
  if (counts.incomplete > 0) return 'incomplete';
  if (counts.short > 0) return 'short';
  if (counts.absent > 0) return 'absent';
  return 'overtime';
}

/** Shape-check a section from the query string; anything else is not a section. */
export function parseSection(raw: string | undefined): AttendanceSection | null {
  return (['overtime', 'short', 'incomplete', 'absent'] as const).includes(raw as never)
    ? (raw as AttendanceSection)
    : null;
}
