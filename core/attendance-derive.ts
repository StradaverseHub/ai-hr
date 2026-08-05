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
 *  • otByRate    — the day's overtime by RATE COLUMN. 7c834696 stage 1 gave the engine somewhere to store
 *                  a real, band-driven split, so this now PREFERS the stored figures and keeps the old
 *                  read-time routing only as the fallback for rows nothing has re-derived.
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
  // 7c834696 stage 1 — the STORED per-rate overtime split (migration 0394), written by the engine from the
  // day's rule bands. NULL on any row no engine has touched since the release; otByRate falls back to the
  // routing below when they are absent, so the two never disagree about a historical day.
  otFlatMinutes?: number | null;
  ot00Minutes?: number | null;
  ot10Minutes?: number | null;
  ot15Minutes?: number | null;
  ot20Minutes?: number | null;
  ot30Minutes?: number | null;
  /** True when the no-work day came from an EXPLICIT rostered rest day (→ "Rest"); a policy / default-shift
   *  pattern non-working day is "OFF". Only meaningful when the day resolves to rest_day. */
  isRosterRest: boolean;
};

/**
 * The rate columns, in MINUTES, as the Records tables render them.
 *
 * EVERY ONE OF THEM IS OVERTIME. `ot10` is overtime a rule categorised at 1.0× and nothing else; `flat` is
 * a flat-rate band's hours and `ot00` hours at a configured rate of 0 ("record but do not pay").
 *
 * Sum(flat, ot00, ot10, ot15, ot20, ot30) === the day's otMinutes. Normal-within-schedule hours are NOT in
 * here — they are the Actual Working Hours column, which already carries the day's whole worked total.
 */
export type OtByRate = { flat: number; ot00: number; ot10: number; ot15: number; ot20: number; ot30: number };

/** The row shape otByRate reads. */
type OtByRateInput = Pick<
  AttendanceDeriveRow,
  'workedMinutes' | 'otMinutes' | 'dayType' | 'otFlatMinutes' | 'ot00Minutes' | 'ot10Minutes' | 'ot15Minutes' | 'ot20Minutes' | 'ot30Minutes'
>;

/**
 * Split a day's OVERTIME into the rate columns the request asks for.
 *
 * 7c834696 rev 2 point 1 — normal working hours no longer land in OT 1.0. Until now this function added
 * `workedMinutes − otMinutes` into the 1.0 column, which is why a plain 9-hour day with an hour of overtime
 * showed 8.00 (or 9.00, when the rule's band was itself at 1.0) under a heading that says OT. The reporter
 * is right that that is a display fault and nothing more: the STORED buckets have always been overtime-only
 * (db/schema.ts), and migration 0395 wrote ot10_minutes = 0 for history rather than back-filling normal
 * hours into it. Removing the addition is therefore a read-layer change with no data behind it.
 *
 * PREFERRED SOURCE — the STORED split (7c834696 stage 1): the engine categorises the day's overtime through
 * the rule's configured bands, progressively, and stores the result. Handed through verbatim.
 *
 * FALLBACK — the pre-7c834696 read-time routing of the day's otMinutes, for every row no engine has
 * re-derived: workday → 1.5, rest_day → 2.0, holiday → 3.0.
 *
 * The fallback also catches a stored split that does NOT sum to the day's overtime. That can only happen if
 * something wrote one of the two halves without the other, and in that case the SPLIT is the untrustworthy
 * one — `otMinutes` is what payroll pays from. Trusting it blindly would let the table show a total that
 * disagrees with the payslip, so the guard is deliberate rather than defensive noise.
 *
 * Either way the columns sum back to the day's otMinutes, never to workedMinutes. A no-attendance day has
 * nothing to split → all zero (the caller renders those as "—").
 */
export function otByRate(row: OtByRateInput): OtByRate {
  const worked = row.workedMinutes ?? 0;
  const ot = Math.max(0, Math.min(row.otMinutes ?? 0, worked)); // OT can never exceed worked

  const stored = {
    flat: row.otFlatMinutes,
    ot00: row.ot00Minutes,
    ot10: row.ot10Minutes,
    ot15: row.ot15Minutes,
    ot20: row.ot20Minutes,
    ot30: row.ot30Minutes,
  };
  const values = Object.values(stored);
  if (values.every((v) => v != null)) {
    const sum = values.reduce((a: number, v) => a + (v as number), 0);
    if (sum === ot) {
      return {
        flat: stored.flat!,
        ot00: stored.ot00!,
        ot10: stored.ot10!,
        ot15: stored.ot15!,
        ot20: stored.ot20!,
        ot30: stored.ot30!,
      };
    }
  }

  const bucket: OtByRate = { flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 0, ot30: 0 };
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
