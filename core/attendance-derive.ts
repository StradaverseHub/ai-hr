/**
 * Attendance Records Table Enhancement (feedback bbada39c) — READ-TIME derivations.
 *
 * Pure, side-effect-free helpers shared by the read loaders (core/attendance.ts) and the two Records
 * tables (app/attendance/daily + individual). No DB, no 'use client' — so a Server Component may import +
 * CALL them directly (RSC boundary rule) and unit tests can exercise them with zero fixtures.
 *
 * Three derivations the request asks for, all computed from what the attendance row already carries plus
 * the resolved schedule surfaced by the loaders — no new stored columns:
 *
 *  • otByRate    — split the day's single stored otMinutes + normal-within-schedule into the four
 *                  standard Malaysian OT rate buckets (1.0 / 1.5 / 2.0 / 3.0).
 *  • flagOf      — the operational irregularity flag (Late / Under / Odd / none).
 *  • statusOf    — the v1 attendance Status (Present / Absent / Rest / OFF / PH / On-Leave).
 *
 * DOCUMENTED v1 SCOPE (per the approved plan + build direction): the finer leave sub-codes AL / ML / EL /
 * RL and the Travel / Training states are a FOLLOW-UP — the loader collapses every approved leave day to a
 * single `on_leave` context (approvedLeaveDates returns no leave-type code), so statusOf can only surface a
 * single "On Leave". Do not fabricate sub-codes here.
 */
import type { DayType } from './attendance';

/** A no-work day (rest / off / holiday / leave / plain absence) carries no attendance row. */
export type DayContext = 'on_leave' | 'holiday' | 'rest_day' | null;

/** The minimal row shape the derivations read — a subset of both loader row types. */
export type AttendanceDeriveRow = {
  attendanceId: string | null;
  status: string | null;
  context: DayContext;
  checkInAt: string | null;
  checkOutAt: string | null;
  dayType: DayType | null;
  workedMinutes: number | null;
  /** Net scheduled work minutes for the resolved shift/policy that day; null on a no-work (rest/off) day. */
  scheduledMinutes: number | null;
  otMinutes: number | null;
  /** True when the no-work day came from an EXPLICIT rostered rest day (→ "Rest"); a policy / default-shift
   *  pattern non-working day is "OFF". Only meaningful when the day resolves to rest_day. */
  isRosterRest: boolean;
};

/** The four rate buckets, in MINUTES. ot10 is normal-within-schedule; the premium buckets are the day's
 *  otMinutes routed by its frozen dayType. Sum(ot10..ot30) === workedMinutes (i.e. normal + otMinutes). */
export type OtByRate = { ot10: number; ot15: number; ot20: number; ot30: number };

/**
 * Split a day into the four OT rate columns the request asks for. There is NO stored per-rate OT — the
 * engine keeps a single scalar otMinutes + the frozen dayType — so we derive at read time (build direction):
 *
 *   • normal-within-schedule  → OT 1.0   (workedMinutes − otMinutes)
 *   • the day's otMinutes routed by dayType:
 *        workday   → OT 1.5
 *        rest_day  → OT 2.0
 *        holiday   → OT 3.0
 *
 * The four therefore sum back to workedMinutes (= normal hours + otMinutes), the invariant the tests pin.
 * A no-attendance day (or null worked) has nothing to split → all zero (the caller renders those as "—").
 */
export function otByRate(row: Pick<AttendanceDeriveRow, 'workedMinutes' | 'otMinutes' | 'dayType'>): OtByRate {
  const worked = row.workedMinutes ?? 0;
  const ot = Math.max(0, Math.min(row.otMinutes ?? 0, worked)); // OT can never exceed worked
  const normal = Math.max(0, worked - ot); // normal-within-schedule → 1.0×
  const bucket = { ot10: normal, ot15: 0, ot20: 0, ot30: 0 };
  if (ot > 0) {
    if (row.dayType === 'holiday') bucket.ot30 = ot;
    else if (row.dayType === 'rest_day') bucket.ot20 = ot;
    else bucket.ot15 = ot; // workday (and the null/default case)
  }
  return bucket;
}

export type AttendanceFlag = 'late' | 'under' | 'odd' | null;

/**
 * The operational irregularity flag — distinct from Status (the request keeps them separate columns).
 * Precedence: Odd (a single punch is the most severe data problem) → Late → Under → none/blank.
 *
 *   • Odd   — exactly one of check-in / check-out is recorded (missing punch).
 *   • Late  — the engine already classified the day 'late' (late arrival on a workday).
 *   • Under — a complete day whose worked minutes fell short of the scheduled minutes (left early). Only
 *             meaningful on a workday with a known schedule (rest/holiday work is all OT — no shortfall).
 *   • null  — clean day / no attendance row.
 */
export function flagOf(row: Pick<AttendanceDeriveRow, 'attendanceId' | 'status' | 'checkInAt' | 'checkOutAt' | 'dayType' | 'workedMinutes' | 'scheduledMinutes'>): AttendanceFlag {
  if (!row.attendanceId) return null;
  const hasIn = row.checkInAt != null;
  const hasOut = row.checkOutAt != null;
  if (hasIn !== hasOut) return 'odd';
  if (row.status === 'late') return 'late';
  if (
    row.dayType === 'workday' &&
    row.workedMinutes != null &&
    row.scheduledMinutes != null &&
    row.workedMinutes < row.scheduledMinutes
  ) {
    return 'under';
  }
  return null;
}

/** The v1 Status set. Sub-codes (AL/ML/EL/RL) and Travel/Training are a documented follow-up. */
export type AttendanceStatus = 'present' | 'absent' | 'rest' | 'off' | 'ph' | 'on_leave';

/**
 * The single attendance Status the request wants ALWAYS shown — one clean state per row, with the
 * irregularities (late / short / missing punch) pushed to the Flag column.
 *
 *   • An attendance row present → Present, except an explicit 'absent' row → Absent. (late / half_day /
 *     present all read as Present; their irregularity surfaces via flagOf.)
 *   • No row → the context that explains it: on_leave → On Leave; holiday → PH; rest_day → Rest when it
 *     came from an explicit rostered rest day, else OFF (a policy / default-shift pattern non-working day).
 *   • No row, no context, a working day → Absent.
 */
export function statusOf(row: Pick<AttendanceDeriveRow, 'attendanceId' | 'status' | 'context' | 'isRosterRest'>): AttendanceStatus {
  if (row.attendanceId && row.status) {
    return row.status === 'absent' ? 'absent' : 'present';
  }
  if (row.context === 'on_leave') return 'on_leave';
  if (row.context === 'holiday') return 'ph';
  if (row.context === 'rest_day') return row.isRosterRest ? 'rest' : 'off';
  return 'absent';
}
