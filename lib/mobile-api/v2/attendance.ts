/**
 * M12 (D13) — the employee's own attendance in the app: records and the personal roster (read only), own application
 * history and detail, the missed-punch/correction request, withdrawing an own pending application, the
 * replacement-leave (Leave Credit) request and the self overtime plan (Apply OT Plan, without its attachment;
 * withdrawing a plan stays on the web). v2 only: every shape
 * here is new, and v1's enums are closed (common.ts). Imported by route handlers AND by the Expo app, so this file
 * stays dependency-free (zod and common.ts only, no server module, no 'server-only').
 *
 * Nothing here is an attendance rule. Every status, figure, exception, workflow level, eligibility answer and action
 * offered is computed on the server by the owners the web's own screens use (core/mobile-attendance.ts says which);
 * the app renders them and never derives one. Every date is a calendar date and every clock time a wall time in
 * `timeZone`, the kernel's authoritative business-day zone (lib/hr-date.ts HR_LOCAL_TZ), never the device's.
 *
 *   GET  /api/mobile/v2/attendance/records?employmentId&from&to            → AttendanceRecordsV2
 *   GET  /api/mobile/v2/attendance/roster?employmentId&from&to             → AttendanceRosterV2
 *   GET  /api/mobile/v2/attendance/day?employmentId&date                   → AttendanceDayResult
 *   GET  /api/mobile/v2/attendance/applications?employmentId&status&cursor&limit → AttendanceApplicationsPageV2
 *   GET  /api/mobile/v2/attendance/applications/{id}?employmentId          → AttendanceApplicationResult
 *   POST /api/mobile/v2/attendance/applications/{id}/withdraw?employmentId {requestId} → AttendanceWithdrawResult
 *   POST /api/mobile/v2/attendance/corrections?employmentId {requestId, date, checkIn?, checkOut?, reason, remark?}
 *                                                                          → AttendanceCorrectionResult
 *   GET  /api/mobile/v2/attendance/replacement-leave?employmentId           → ReplacementLeaveOfferV2
 *   GET  /api/mobile/v2/attendance/replacement-leave/day?employmentId&date&start&end → ReplacementLeaveDayResult
 *   POST /api/mobile/v2/attendance/replacement-leave?employmentId {requestId, rows[], reason, firstScheduleConsent}
 *                                                                          → ReplacementLeaveResult
 *   GET  /api/mobile/v2/attendance/overtime-plans/offer?employmentId       → OvertimePlanOfferV2
 *   POST /api/mobile/v2/attendance/overtime-plans?employmentId {requestId, date, plannedStart, plannedEnd, reason, remark?}
 *                                                                          → OvertimePlanResult
 */
import { z } from 'zod';
import { commandOf, pageOf, refusalOf } from './common';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const calendarDate = isoDate.refine((v) => { const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
/** A wall-clock time `HH:MM` (24-hour) in `timeZone`. */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const instant = z.string().max(40);
const name = z.string().max(300);
const minutes = z.number().int();
const text = (max: number) => z.string().max(max);
/** The kernel's business-day zone, sent with every attendance answer (an IANA name). */
const timeZone = z.string().min(1).max(64);

/** One read covers at most a calendar month (31 days); the app steps month by month. */
export const ATTENDANCE_WINDOW_MAX_DAYS = 31;

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────

/** core/attendance-derive.ts AttendanceStatus — the personal status the web's list prints. */
export const AttendanceDayStatus = z.enum(['present', 'absent', 'exempt', 'rest', 'off', 'ph', 'on_leave']);
export type AttendanceDayStatus = z.infer<typeof AttendanceDayStatus>;
/** core/attendance-derive.ts AttendanceFlag — the unresolved exception on the day, if any. */
export const AttendanceException = z.enum(['late', 'under', 'odd']);
export type AttendanceException = z.infer<typeof AttendanceException>;

/**
 * One day, in four separate parts that are never merged:
 *   schedule  what the day was scheduled as (the engine's shift display, day type and the context of a no-row day);
 *   punches   the clockings in force on record for the day, as evidence, in the kernel's order (voided originals are
 *             HR's raw clock data and are not sent; a corrected day shows the punches the correction put in force);
 *   outcome   the derived (or corrected) result the engine stored;
 *   exception the unresolved exception the web flags, or null.
 * Overnight: a day is the SHIFT START day, as the engine dates it; `schedule.crossesMidnight` (core/roster.ts
 * shiftCrossesMidnight, the rule a shift is saved with) says the shift ends on the next calendar day, and a
 * clock-out after midnight is on this day's row.
 */
export const AttendanceDayV2 = z.object({
  date: isoDate,
  schedule: z.object({
    shiftCode: name.nullable(),
    start: clock.nullable(),
    end: clock.nullable(),
    crossesMidnight: z.boolean(),
    /** Net scheduled minutes (the engine's figure). */
    scheduledMinutes: z.number().nullable(),
    rosteredRest: z.boolean(),
    dayType: z.enum(['workday', 'rest_day', 'holiday']).nullable(),
    context: z.enum(['on_leave', 'holiday', 'rest_day']).nullable(),
  }),
  punches: z.array(z.object({ at: clock, direction: z.enum(['in', 'out']) })).max(100),
  outcome: z.object({
    /** An attendance row exists for the day. */
    recorded: z.boolean(),
    checkIn: clock.nullable(),
    checkOut: clock.nullable(),
    workedMinutes: minutes.nullable(),
    lateMinutes: minutes.nullable(),
    earlyOutMinutes: minutes.nullable(),
    status: AttendanceDayStatus.nullable(),
  }),
  exception: AttendanceException.nullable(),
});
export type AttendanceDayV2 = z.infer<typeof AttendanceDayV2>;

/** `enabled: false` ⇔ the Attendance module is off: nothing is read. `employmentId` null: no own employment. */
export const AttendanceRecordsV2 = z.object({
  enabled: z.boolean(),
  employmentId: z.string().uuid().nullable(),
  timeZone,
  /** The kernel's business day today (todayInKualaLumpur), so the app never asks the device what day it is. */
  today: isoDate,
  from: isoDate,
  to: isoDate,
  /** Ascending by date, one per calendar day of the window. */
  days: z.array(AttendanceDayV2).max(ATTENDANCE_WINDOW_MAX_DAYS),
});
export type AttendanceRecordsV2 = z.infer<typeof AttendanceRecordsV2>;

// ── Roster ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One roster date as My Roster resolves it (core/roster.ts myRosterWindow / resolveRosterCell): a rostered shift,
 * the usual (default) shift, an explicit rest day, off (not scheduled) or none.
 */
export const AttendanceRosterDayV2 = z.object({
  date: isoDate,
  kind: z.enum(['shift', 'usual', 'rest', 'off', 'none']),
  shift: z.object({ code: name, name, start: clock.nullable(), end: clock.nullable(), crossesMidnight: z.boolean(), workingMinutes: z.number() }).nullable(),
  plannedMinutes: z.number(),
  note: text(2000).nullable(),
});
export type AttendanceRosterDayV2 = z.infer<typeof AttendanceRosterDayV2>;
export const AttendanceRosterV2 = z.object({
  enabled: z.boolean(),
  employmentId: z.string().uuid().nullable(),
  timeZone,
  from: isoDate,
  to: isoDate,
  days: z.array(AttendanceRosterDayV2).max(ATTENDANCE_WINDOW_MAX_DAYS),
  totals: z.object({ workDays: minutes, rosteredDays: minutes, restDays: minutes, plannedMinutes: z.number() }),
});
export type AttendanceRosterV2 = z.infer<typeof AttendanceRosterV2>;

// ── Applications (own history) ─────────────────────────────────────────────────────────────────────────

/** The four stored statuses (attendance_correction_status), the history's filter chips. */
export const ATTENDANCE_APPLICATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const AttendanceApplicationStatus = z.enum(ATTENDANCE_APPLICATION_STATUSES);
export type AttendanceApplicationStatus = z.infer<typeof AttendanceApplicationStatus>;
/** What the employee reads (app/attendance/request-ui.tsx statusLabel): a cancelled row is `withdrawn` unless HR cancelled it. */
export const AttendanceApplicationDisplay = z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'cancelled']);
export type AttendanceApplicationDisplay = z.infer<typeof AttendanceApplicationDisplay>;
/** lib/attendance-workflow.ts attendanceApplicationType (correction / overtime), and HR's clock-data proposals. */
export const AttendanceApplicationKind = z.enum(['correction', 'overtime', 'clock_data']);
export type AttendanceApplicationKind = z.infer<typeof AttendanceApplicationKind>;
export const AttendanceRequestKind = z.enum(['self_overtime', 'short_hours', 'incomplete_entry', 'absent', 'other']);

/** What was asked for — the request's own proposed values, never a recomputed figure. */
const asked = z.object({
  checkIn: clock.nullable(),
  checkOut: clock.nullable(),
  requestedOtMinutes: minutes.nullable(),
  plannedStart: clock.nullable(),
  plannedEnd: clock.nullable(),
  /** Clock-data corrections only: how many clockings the proposal leaves in force. */
  clockEntries: minutes.nullable(),
});
export const AttendanceApplicationSummaryV2 = z.object({
  id: z.string().uuid(),
  date: isoDate,
  application: AttendanceApplicationKind,
  requestKind: AttendanceRequestKind.nullable(),
  status: AttendanceApplicationStatus,
  displayStatus: AttendanceApplicationDisplay,
  asked,
  /** The tenant-local calendar day it was filed. */
  submittedOn: isoDate,
});
export type AttendanceApplicationSummaryV2 = z.infer<typeof AttendanceApplicationSummaryV2>;
/** Keyset tuple: the kernel's own order (attendance date desc, created desc, id desc); `at` is microsecond UTC text. */
export const ATTENDANCE_APPLICATIONS_CURSOR = 'attendance.applications';
export const AttendanceApplicationsCursor = z.tuple([isoDate, z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), z.string().uuid()]);
export const AttendanceApplicationsPageV2 = pageOf(AttendanceApplicationSummaryV2).extend({
  enabled: z.boolean(),
  employmentId: z.string().uuid().nullable(),
  timeZone,
  /** Per stored status, ignoring the status filter (the chips' badges). */
  counts: z.object({ pending: minutes.nonnegative(), approved: minutes.nonnegative(), rejected: minutes.nonnegative(), cancelled: minutes.nonnegative() }),
});
export type AttendanceApplicationsPageV2 = z.infer<typeof AttendanceApplicationsPageV2>;

/**
 * One approval level of the routing recorded WITH the application (the snapshot taken at submission — a later
 * change of template does not rewrite it). `status`: approved / rejected (decided), waiting (where a pending
 * application is), not_reached (later, still pending), not_required (the application ended before it).
 */
export const AttendanceApplicationLevelV2 = z.object({
  level: z.number().int().positive(),
  name: name,
  status: z.enum(['approved', 'rejected', 'waiting', 'not_reached', 'not_required']),
  /** Who it is assigned to; `hr` ⇒ the HR administrators. */
  approvers: z.array(z.object({ kind: z.enum(['person', 'hr']), name: name })).max(20),
  decision: z.object({ actorName: name, actingMode: z.enum(['assigned', 'delegate', 'administrator']), decidedAt: instant, remarks: text(2000).nullable() }).nullable(),
});
export type AttendanceApplicationLevelV2 = z.infer<typeof AttendanceApplicationLevelV2>;
export const AttendanceApplicationDetailV2 = AttendanceApplicationSummaryV2.extend({
  reason: text(2000).nullable(),
  remark: text(2000).nullable(),
  /** The clock pair on record when it was filed (the request's own snapshot); null when none was taken. */
  original: z.object({ checkIn: clock.nullable(), checkOut: clock.nullable(), capturedAt: instant.nullable() }).nullable(),
  rejectReason: text(2000).nullable(),
  decidedAt: instant.nullable(),
  hasAttachment: z.boolean(),
  /** The routing recorded at submission; null for a request filed before workflows (decided by its manager/HR). */
  routing: z.object({ templateName: name, templateVersion: z.number().int(), currentLevel: z.number().int().positive().nullable(), levels: z.array(AttendanceApplicationLevelV2).max(20) }).nullable(),
  /** What the employee may do now, from the web's own predicate (request-status canCancel). */
  actions: z.object({ withdraw: z.boolean() }),
});
export type AttendanceApplicationDetailV2 = z.infer<typeof AttendanceApplicationDetailV2>;
export const AttendanceApplicationResult = z.union([
  z.object({ outcome: z.literal('found'), timeZone, application: AttendanceApplicationDetailV2 }),
  refusalOf(['not_found', 'module_off']),
]);
export type AttendanceApplicationResult = z.infer<typeof AttendanceApplicationResult>;

// ── One day, for the day screen and the correction form ────────────────────────────────────────────────

export const AttendanceDayResult = z.union([
  z.object({
    outcome: z.literal('found'),
    timeZone,
    today: isoDate,
    day: AttendanceDayV2,
    /** The caller's own applications for this date, newest first. */
    applications: z.array(AttendanceApplicationSummaryV2).max(100),
    /**
     * Whether the web's day screen offers its correction form (app/attendance/my-records/[date]): not for a future
     * date, not while an application for the date is pending. The kernel re-decides on submit.
     */
    correction: z.object({ offered: z.boolean(), blockedBy: z.enum(['future', 'pending']).nullable() }),
  }),
  refusalOf(['not_found', 'module_off']),
]);
export type AttendanceDayResult = z.infer<typeof AttendanceDayResult>;

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Command refusals. `not_found`: not the caller's own selected employment's (or guessed); `module_off`: the
 * Attendance module is off; `request_conflict`: the requestId already recorded a different command;
 * `future`, `pending_exists`, `payroll_closed`, `workflow_unavailable`, `invalid`: the kernel's own refusals
 * (requestAttendanceCorrection / AttendanceLevelError / AttendanceWorkflowError), `message` carries its sentence —
 * for an overtime plan `invalid` also carries the kernel's "already approved / already counted for this date";
 * `not_withdrawable`: the application is no longer pending, or is an overtime plan (withdrawn on the web).
 */
export const ATTENDANCE_COMMAND_REFUSALS = [
  'not_found', 'module_off', 'request_conflict', 'future', 'pending_exists', 'payroll_closed',
  'workflow_unavailable', 'invalid', 'not_withdrawable',
] as const;
export type AttendanceCommandRefusalCode = (typeof ATTENDANCE_COMMAND_REFUSALS)[number];
export const AttendanceCommandRefusal = refusalOf(ATTENDANCE_COMMAND_REFUSALS);
export type AttendanceCommandRefusal = z.infer<typeof AttendanceCommandRefusal>;

/**
 * A missed-punch / correction request for one day: proposed clock-in and/or clock-out and a mandatory reason
 * (≤500, the web day screen's bound), an optional remark. The kernel validates the rest (requestAttendanceCorrection).
 * A raw punch is never edited: approval re-derives the day and keeps the originals.
 */
export const AttendanceCorrectionCommand = commandOf({
  date: calendarDate,
  checkIn: clock.optional(),
  checkOut: clock.optional(),
  reason: z.string().trim().min(1).max(500),
  remark: z.string().trim().max(2000).optional(),
});
export type AttendanceCorrectionCommand = z.infer<typeof AttendanceCorrectionCommand>;
export const AttendanceCorrectionResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('submitted'), id: z.string().uuid(), date: isoDate }),
  AttendanceCommandRefusal,
]);
export type AttendanceCorrectionResult = z.infer<typeof AttendanceCorrectionResult>;

export const AttendanceWithdrawCommand = commandOf({});
export const AttendanceWithdrawResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('withdrawn'), id: z.string().uuid() }),
  AttendanceCommandRefusal,
]);
export type AttendanceWithdrawResult = z.infer<typeof AttendanceWithdrawResult>;

// ── Replacement leave (Leave Credit) ───────────────────────────────────────────────────────────────────

/** lib/leave-credit-day-type.ts LEAVE_CREDIT_DAY_TYPES — what the roster holds for the worked date. */
export const LeaveCreditDayType = z.enum(['rest_day', 'off_day', 'holiday', 'workday']);
export type LeaveCreditDayType = z.infer<typeof LeaveCreditDayType>;
/** lib/replacement-availability.ts ReplacementUnavailableReason, plus `no_leave_type` (the tenant has no Replacement Leave type). */
export const ReplacementUnavailable = z.enum(['module_off', 'no_employment', 'not_enabled', 'employee_requests_off', 'not_eligible', 'first_schedule_protected', 'no_leave_type']);
export type ReplacementUnavailable = z.infer<typeof ReplacementUnavailable>;

/** The kernel's answer to "may I ask for a Leave Credit", with what the form needs when it may. */
export const ReplacementLeaveOfferV2 = z.object({
  employmentId: z.string().uuid().nullable(),
  timeZone,
  /** The kernel's business day today; a worked date after it is refused by the kernel. */
  today: isoDate,
  allowed: z.boolean(),
  reason: ReplacementUnavailable.nullable(),
  requiresFirstScheduleConsent: z.boolean(),
  leaveType: z.object({ id: z.string().uuid(), name }).nullable(),
  /** The company's tier ladder (minutes) and whether an ordinary working day may earn a credit. */
  tiers: z.object({ halfDayMinutes: minutes, fullDayMinutes: minutes }).nullable(),
  ordinaryDayAllowed: z.boolean(),
});
export type ReplacementLeaveOfferV2 = z.infer<typeof ReplacementLeaveOfferV2>;

/**
 * One worked date's facts (extendedHoursDayForEmployment) and, when a window is given, the kernel's own review of
 * it (leaveCreditClaimReview). `review.creditDays` is the kernel's credit for the window, never the app's.
 */
export const ReplacementLeaveDayV2 = z.object({
  date: isoDate,
  dayType: LeaveCreditDayType,
  shiftCode: name.nullable(),
  shiftStart: clock.nullable(),
  shiftEnd: clock.nullable(),
  actualClockIn: clock.nullable(),
  actualClockOut: clock.nullable(),
  approvedOvertime: z.object({ start: clock.nullable(), end: clock.nullable(), minutes: z.number() }).nullable(),
  review: z.object({
    /** ready ⇒ the window earns `creditDays`; anything else ⇒ it cannot be submitted as is (legacy: the old rule applies). */
    state: z.enum(['ready', 'refused', 'incomplete', 'unavailable', 'legacy']),
    reason: z.string().max(64).nullable(),
    eligibleMinutes: z.number().nullable(),
    creditDays: z.number().nullable(),
    /** lib/extended-hours.ts claimCrossesMidnight: an end before the start was read as the next day. */
    crossesMidnight: z.boolean(),
  }).nullable(),
});
export type ReplacementLeaveDayV2 = z.infer<typeof ReplacementLeaveDayV2>;
export const ReplacementLeaveDayResult = z.union([
  z.object({ outcome: z.literal('found'), timeZone, day: ReplacementLeaveDayV2 }),
  refusalOf(['not_found', 'unavailable']),
]);
export type ReplacementLeaveDayResult = z.infer<typeof ReplacementLeaveDayResult>;

/** One worked date per row: the day type the facts showed (the kernel adjudicates it against the roster) and the claimed window. */
export const ReplacementLeaveRow = z.object({ workedDate: calendarDate, dayType: LeaveCreditDayType, claimStart: clock, claimEnd: clock });
export const ReplacementLeaveCommand = commandOf({
  rows: z.array(ReplacementLeaveRow).min(1).max(31),
  reason: z.string().trim().min(1).max(2000),
  firstScheduleConsent: z.boolean(),
});
export type ReplacementLeaveCommand = z.infer<typeof ReplacementLeaveCommand>;
/**
 * `disabled`, `not_eligible`, `consent_required`, `day_type_mismatch`, `below_threshold`, `already_credited`,
 * `overtime_claimed`: the leave pack's own refusals; `invalid`: any other leave-domain refusal (message carried).
 */
export const REPLACEMENT_LEAVE_REFUSALS = [
  'module_off', 'request_conflict', 'no_employment', 'no_leave_type', 'disabled', 'not_eligible', 'consent_required',
  'day_type_mismatch', 'below_threshold', 'already_credited', 'overtime_claimed', 'invalid',
] as const;
export type ReplacementLeaveRefusalCode = (typeof REPLACEMENT_LEAVE_REFUSALS)[number];
export const ReplacementLeaveRefusal = refusalOf(REPLACEMENT_LEAVE_REFUSALS);
export type ReplacementLeaveRefusal = z.infer<typeof ReplacementLeaveRefusal>;
export const ReplacementLeaveResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('submitted'), id: z.string().uuid(), totalDays: z.number() }),
  ReplacementLeaveRefusal,
]);
export type ReplacementLeaveResult = z.infer<typeof ReplacementLeaveResult>;


// ── Self overtime plan (Apply OT Plan) ─────────────────────────────────────────────────────────────────

/**
 * Why the app may not offer the plan form: `module_off` — the Attendance module is off (the web's attendance layout
 * redirects away); `no_employment` — the login has no active employment (the web's apply page shows "not linked").
 * Those are the only two cases the web's apply page refuses; nothing else hides its form.
 */
export const OvertimePlanUnavailable = z.enum(['module_off', 'no_employment']);
export type OvertimePlanUnavailable = z.infer<typeof OvertimePlanUnavailable>;
export const OvertimePlanOfferV2 = z.object({
  /** The Attendance module is on. */
  enabled: z.boolean(),
  employmentId: z.string().uuid().nullable(),
  allowed: z.boolean(),
  reason: OvertimePlanUnavailable.nullable(),
  timeZone,
  /** The kernel's business day today. A past date is accepted (overtime claimed after the fact), as on the web. */
  today: isoDate,
});
export type OvertimePlanOfferV2 = z.infer<typeof OvertimePlanOfferV2>;

/**
 * One overtime plan for one date: the planned window (`HH:MM`, an end before the start runs into the next day, equal
 * times are refused — lib/overtime-duration.ts plannedOvertimeMinutes, the web form's own rule), a mandatory reason
 * and an optional remark. The minutes are derived on the server from the window, never sent by the app.
 */
export const OvertimePlanCommand = commandOf({
  date: calendarDate,
  plannedStart: clock,
  plannedEnd: clock,
  reason: z.string().trim().min(1).max(500),
  remark: z.string().trim().max(2000).optional(),
});
export type OvertimePlanCommand = z.infer<typeof OvertimePlanCommand>;
/** `minutes`: the planned minutes the kernel recorded (requestedOtMinutes). Refusals as AttendanceCommandRefusal. */
export const OvertimePlanResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('submitted'), id: z.string().uuid(), date: isoDate, minutes: z.number().int() }),
  AttendanceCommandRefusal,
]);
export type OvertimePlanResult = z.infer<typeof OvertimePlanResult>;
