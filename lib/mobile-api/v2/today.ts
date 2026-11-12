/**
 * Mobile Today (owner decisions, 12 November 2026): the native Home becomes Today, and its AI reminders mirror the web
 * Employee Today's loop cards (core/loops/cards.ts, AI v2 W8 / P2-1). Imported by route handlers AND by the Expo app, so
 * this file stays dependency-free (zod and common.ts only, no server module, no 'server-only').
 *
 *   GET  /api/mobile/v2/today?employmentId                       → TodayV2
 *   POST /api/mobile/v2/today/clock-out  ClockOutConfirmCommandV2 → ClockOutConfirmResultV2
 *   POST /api/mobile/v2/today/undo       LoopUndoCommandV2        → LoopUndoResultV2
 *
 * WHAT IS READ. Every fact is the web Employee Today's own answer (components/today/employee/reads.ts and
 * lib/today/employee.ts), read as the caller for their own proven employment. Nothing here computes a balance, an
 * amount or a date; no pay figure is ever sent (payday is a date only). Each section is read and fails on its own:
 * `unavailable` means "could not check", which the app must never present as "nothing to do"; `off` means the module is
 * not in use for the person's company and the app draws nothing for it.
 *
 * WHAT A REMINDER MAY DO. A reminder is a loop's proposal. It decides nothing. The app may:
 *   • clockOut — send the person's own Confirm (with the reason they picked or typed) to the clock-out owner, which
 *     re-reads the case and sends an attendance correction for the usual approval (core/loops/clock-out-confirm.ts);
 *   • autoFixed — Undo a clock-out the loop set on the person's own day while its undo window is open
 *     (core/loops/undo.ts);
 *   • record / passport — open the person's own profile, where they send a change request HR decides (ADR-0159).
 * A WEB LINK IS NEVER SENT. Each item carries a typed destination from a closed list; the app maps it to one of its own
 * fixed screens, which read afresh under the caller's session.
 */
import { z } from 'zod';
import { refusalOf } from './common';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const instant = z.string().max(40);
const count = z.number().int().nonnegative();
const minutes = z.number().int().nonnegative();
const uuid = z.string().uuid();
const unavailable = z.object({ status: z.literal('unavailable') });
const off = z.object({ status: z.literal('off') });

/** The app screens a Today item may open. Closed: a new screen is a contract change. */
export const TodayDestination = z.discriminatedUnion('screen', [
  z.object({ screen: z.literal('attendanceDay'), date: day }).strict(),
  z.object({ screen: z.literal('attendanceCorrection'), date: day }).strict(),
  z.object({ screen: z.enum(['profile', 'profileEdit', 'leave', 'leaveHistory', 'approvals', 'pay']) }).strict(),
]);
export type TodayDestination = z.infer<typeof TodayDestination>;

// ── Reminders (the employee loop cards) ─────────────────────────────────────────────────────────────────────────
/** One missing detail on the person's record, labelled by the server in the caller's language. */
const RecordGap = z.object({ key: z.string().min(1).max(80), label: z.string().min(1).max(200) }).strict();
export const TodayReminder = z.discriminatedUnion('kind', [
  /** The missed clock-out loop found a day with a clock-in and no clock-out; `proposedCheckOut` is the loop's proposal. */
  z.object({ kind: z.literal('clockOut'), caseId: uuid, date: day, checkIn: clock, proposedCheckOut: clock }).strict(),
  /** The missing-employee-data loop found gaps on the person's own record. */
  z.object({ kind: z.literal('record'), caseId: uuid, gaps: z.array(RecordGap).min(1).max(20), destination: TodayDestination }).strict(),
  /** The documents loop found the person's passport expiring on `expiresOn`. */
  z.object({ kind: z.literal('passport'), caseId: uuid, expiresOn: day, destination: TodayDestination }).strict(),
  /** The loop set this clock-out on the person's own day (autonomy ladder); Undo is open until `undoUntil`. */
  z.object({ kind: z.literal('autoFixed'), actionId: uuid, date: day, checkOut: clock, undoUntil: instant }).strict(),
]);
export type TodayReminder = z.infer<typeof TodayReminder>;
export const TODAY_REMINDER_LIMIT = 20;

// ── Next steps (the person's own Before payroll checklist `todo` items, and passports to renew) ──────────────────
/** The step kinds the app knows (lib/pre-salary/items.ts PAYROLL_ITEM_KINDS without approvals, plus passport_renew).
 * A kind outside this list is not sent (the server counts it in `more`). */
export const TODAY_STEP_KINDS = [
  'missed_clock_in', 'missed_clock_out', 'absent_no_leave', 'late_or_early', 'attendance_request_pending',
  'overtime_pending', 'overtime_over_cap',
  'leave_pending', 'leave_unpaid', 'leave_certificate_missing',
  'claim_deadline', 'claim_receipt_missing', 'claim_draft', 'claim_pending',
  'toil_pending',
  'bank_missing', 'tax_number_missing', 'epf_number_missing', 'socso_number_missing', 'identity_missing',
  'details_request_pending', 'tp3_new_joiner', 'tp1_draft', 'tp1_pending', 'dependants_mismatch',
  'letter_acknowledge', 'notice_acknowledge', 'review_acknowledge', 'onboarding_acknowledge',
  'passport_renew',
] as const;
export const TodayStepKind = z.enum(TODAY_STEP_KINDS);
export type TodayStepKind = z.infer<typeof TodayStepKind>;
export const TodayStep = z.object({
  /** Opaque and stable within one read; a React key only. */
  key: z.string().min(1).max(200),
  kind: TodayStepKind,
  /** When it must be done by (its own deadline or the payroll cut-off), or null when no owner gave one. */
  due: day.nullable(),
  /** The day the step is about, and its last day for a range. */
  date: day.nullable(),
  endDate: day.nullable(),
  /** The person's own leave or claim type name, as its owner names it. */
  label: z.string().max(200).nullable(),
  /** Who decides once the person has sent it; `you` means nothing is sent. */
  decider: z.enum(['hr', 'manager', 'you']),
  /** null: the step has no native screen yet (the app says to finish it on the web). */
  destination: TodayDestination.nullable(),
}).strict();
export type TodayStep = z.infer<typeof TodayStep>;
export const TODAY_STEP_LIMIT = 20;

// ── This week's hours (lib/today/employee.ts weekHours) ────────────────────────────────────────────────────────────
export const TodayHoursBar = z.object({
  date: day,
  state: z.enum(['worked', 'running', 'none', 'upcoming']),
  workedMinutes: minutes.nullable(),
  scheduledMinutes: minutes.nullable(),
}).strict();
export const TodayWeekHours = z.object({ bars: z.array(TodayHoursBar).max(7), workedMinutes: minutes, shiftMinutes: minutes.nullable() }).strict();
export type TodayWeekHours = z.infer<typeof TodayWeekHours>;

// ── Payday (lib/today/employee.ts paydayView: a date, never an amount) ─────────────────────────────────────────────
export const TodayPayday = z.object({ kind: z.enum(['payday', 'cutoff']), date: day, daysAway: count }).strict();

// ── Coming up (lib/today/employee.ts comingUp) ──────────────────────────────────────────────────────────────────────
export const TodayComingUp = z.object({
  date: day, endDate: day,
  kind: z.enum(['payday', 'cutoff', 'leave', 'holiday', 'managerAway']),
  /** A holiday's name or the manager's name, through their owners' row-level security; otherwise null. */
  name: z.string().max(200).nullable(),
}).strict();
export type TodayComingUp = z.infer<typeof TodayComingUp>;
export const TODAY_COMING_UP_LIMIT = 4;

export const TodayV2 = z.object({
  /** Today in the HR business-day zone (lib/hr-date.ts), the date every section was read for. */
  date: day,
  reminders: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), items: z.array(TodayReminder).max(TODAY_REMINDER_LIMIT) }).strict(), unavailable]),
  /** `partial`: at least one source could not be read, so an empty list is never "all clear". `more`: steps not sent. */
  steps: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), items: z.array(TodayStep).max(TODAY_STEP_LIMIT), more: count, partial: z.boolean() }).strict(), unavailable]),
  hours: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), week: TodayWeekHours }).strict(), off, unavailable]),
  payday: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), next: TodayPayday.nullable() }).strict(), off, unavailable]),
  comingUp: z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), items: z.array(TodayComingUp).max(TODAY_COMING_UP_LIMIT) }).strict(), unavailable]),
});
export type TodayV2 = z.infer<typeof TodayV2>;

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────
export const CLOCK_OUT_REASONS_V2 = ['forgot', 'device', 'other'] as const;
export type ClockOutReasonV2 = (typeof CLOCK_OUT_REASONS_V2)[number];
/** lib/today/clock-out-reasons.ts CLOCK_OUT_OTHER_MAX. */
export const CLOCK_OUT_OTHER_MAX_V2 = 500;
/** The person's explicit Confirm. The date and proposed clock-out are never posted: the owner reads them from the case. */
export const ClockOutConfirmCommandV2 = z.union([
  z.object({ caseId: uuid, reason: z.enum(['forgot', 'device']), confirm: z.literal(true) }).strict(),
  z.object({ caseId: uuid, reason: z.literal('other'), other: z.string().min(1).max(CLOCK_OUT_OTHER_MAX_V2), confirm: z.literal(true) }).strict(),
]);
export type ClockOutConfirmCommandV2 = z.infer<typeof ClockOutConfirmCommandV2>;
export const CLOCK_OUT_REFUSALS_V2 = ['not_confirmed', 'invalid', 'retired', 'changed', 'unavailable', 'expired', 'access'] as const;
export const ClockOutConfirmResultV2 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('submitted') }).strict(),
  refusalOf(CLOCK_OUT_REFUSALS_V2),
]);
export type ClockOutConfirmResultV2 = z.infer<typeof ClockOutConfirmResultV2>;

export const LoopUndoCommandV2 = z.object({ actionId: uuid, confirm: z.literal(true) }).strict();
export type LoopUndoCommandV2 = z.infer<typeof LoopUndoCommandV2>;
export const LOOP_UNDO_REFUSALS_V2 = ['not_confirmed', 'invalid', 'unavailable', 'expired', 'changed', 'access', 'ask_hr', 'human_review_required'] as const;
export const LoopUndoResultV2 = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('undone') }).strict(),
  refusalOf(LOOP_UNDO_REFUSALS_V2),
]);
export type LoopUndoResultV2 = z.infer<typeof LoopUndoResultV2>;
