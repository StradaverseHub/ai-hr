/**
 * M08 — the approver's task list, one task's facts and the native decision. v2 only: v1's task kinds are closed
 * (lib/mobile-api/contract.ts TasksResponse), so replacement leave and notice acknowledgements appear here only.
 * Imported by route handlers AND by the Expo app, so this file stays dependency-free (zod and common.ts only, no
 * server module, no 'server-only').
 *
 * Nothing here is an approval rule. Who is assigned, what is pending, the expected step/stage and every decision
 * come from the owners the web's own inbox uses (core/mobile-approvals.ts says which); the app renders them.
 *
 *   GET  /api/mobile/v2/tasks?cursor&limit                        → TasksPageV2
 *   GET  /api/mobile/v2/tasks/{kind}/{id}                         → TaskDetailResult
 *   GET  /api/mobile/v2/tasks/leave/{id}/document                 → the attachment bytes, or TaskDocumentRefusal
 *   GET  /api/mobile/v2/tasks/claim/{id}/document?attachment      → one receipt's bytes, or TaskDocumentRefusal (M11)
 *   POST /api/mobile/v2/tasks/{kind}/{id}/decision {requestId, decision, reason?, dates?, expected}
 *                                                                 → TaskDecisionResult
 *
 * Owner decisions (2026-10-28): D2 native decisions for leave (whole and per-date), leave cancellation and
 * attendance applications (clock corrections and overtime, which the kernel decides as one kind); every other
 * kind is listed read-only with its web path. D3 no bulk. D4 self-approval is refused at mobile admission even
 * for super_admin. Online only, explicit confirmation, a rejection reason where the kernel records one.
 * D12 (2026-10-28, amends D2): expense claims are decided natively too — approve, or reject with a reason, through
 * core/claims.ts decideClaim; receipts viewable through the task-scoped document route; no bulk.
 */
import { z } from 'zod';
import { commandOf, pageOf, refusalOf } from './common';
import { MoneyV2 } from './pay';
import { ClaimFieldAnswerV2, ClaimReceiptV2 } from './claims';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const calendarDate = isoDate.refine((v) => { const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
const instant = z.string().max(40);
const name = z.string().max(300);
const clock = z.string().regex(/^\d{2}:\d{2}$/);

/** Every kind the web inbox lists (core/approvals-inbox.ts PendingTaskKind). */
export const TASK_KINDS = ['leave', 'leaveCancellation', 'replacementLeave', 'attendance', 'profile', 'claim', 'resignation', 'managerReview', 'hrReview', 'noticeAcknowledgement',
  // Module-owned kinds (lib/assigned-work.ts PACK_TASK_KINDS), read-only in the app with their web path (D2).
  'performanceReview', 'assessmentWork', 'careerPlan', 'calibration', 'rewardReview'] as const;
export const TaskKind = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKind>;
/** D2: the kinds decided natively. Attendance covers clock corrections AND overtime (one decider). D12 adds claims. */
export const NATIVE_TASK_KINDS = ['leave', 'leaveCancellation', 'attendance', 'claim'] as const;
export const NativeTaskKind = z.enum(NATIVE_TASK_KINDS);
export type NativeTaskKind = z.infer<typeof NativeTaskKind>;
export const isNativeTaskKind = (kind: string): kind is NativeTaskKind => (NATIVE_TASK_KINDS as readonly string[]).includes(kind);

/** A relative web path the app may open on the company's own origin: one leading slash, never `//`. */
const webPath = z.string().max(400).regex(/^\/(?!\/)[^\s\\]*$/);
const subject = z.object({ name: name.nullable(), code: z.string().max(64).nullable() });

/**
 * What the web approvals page prints on this row for this caller (app/(app)/approvals/page.tsx, the same readers under the
 * same session): leave — type, start → end, days; leave cancellation — type, the original leave's start → end, the
 * days given back; attendance — the date; claim — type, amount, the date incurred. Read by `kind`; a fact the
 * web's row does not carry is null. One flat shape (no per-kind union) so a later fact is an additive key.
 */
export const TaskSummaryV2 = z.object({
  label: name.nullable(),
  from: isoDate.nullable(),
  to: isoDate.nullable(),
  days: z.number().nullable(),
  amount: MoneyV2.nullable(),
  currency: z.string().max(8).nullable(),
});
export type TaskSummaryV2 = z.infer<typeof TaskSummaryV2>;

export const TaskItemV2 = z.object({
  /** A UUID for every kind but notice acknowledgements, whose id is the inbox's composite reference. */
  id: z.string().min(1).max(128),
  kind: TaskKind,
  /** The inbox carries the subject's name only; the code is in the detail (TaskDetailV2), null here. */
  subject,
  createdAt: instant,
  nativeDecision: z.boolean(),
  /** Set exactly when `nativeDecision` is false. */
  webPath: webPath.nullable(),
  /**
   * Natively decided kinds only, and only when the web approvals page's own reader returns this row for the caller;
   * null otherwise. Optional: an older server sends none, an older app strips it.
   */
  summary: TaskSummaryV2.nullable().optional(),
});
export type TaskItemV2 = z.infer<typeof TaskItemV2>;
/** Keyset tuple: the inbox's own order (createdAt desc, kind, id — core/approvals-inbox.ts). */
export const TASKS_CURSOR = 'tasks';
export const TasksCursor = z.tuple([instant, TaskKind, z.string().min(1).max(128)]);
export const TasksPageV2 = pageOf(TaskItemV2);
export type TasksPageV2 = z.infer<typeof TasksPageV2>;

/** Team members on leave over the requested dates, for a caller with team access. Names, dates, status; no reasons, no types. */
export const TeamCoverV2 = z.array(z.object({
  name,
  dates: z.array(z.object({ date: isoDate, status: z.enum(['approved', 'pending']) })).max(400),
})).max(50);
export type TeamCoverV2 = z.infer<typeof TeamCoverV2>;

/** What the caller saw, echoed in the decision: the lowest pending leave step (null: no step rows). */
const leaveExpected = z.object({ stepIndex: z.number().int().nonnegative().nullable() });
/** The attendance workflow's current stage and participant slot (both null: no workflow). */
const attendanceExpected = z.object({ stageIndex: z.number().int().nonnegative().nullable(), participantSlot: z.string().min(1).max(64).nullable() });
/**
 * A claim is decided in ONE step (decideClaim: pending → approved | rejected; no chain), so the only state the
 * approver can have seen is `pending`; decideClaim itself refuses any other (`already_decided`).
 */
const claimExpected = z.object({ status: z.literal('pending') });

const common = {
  id: z.string().uuid(),
  subject,
  createdAt: instant,
  /** The kernel records a reason with this rejection, and refuses one without it. */
  reasonRequiredToReject: z.boolean(),
};
export const LeaveTaskDetailV2 = z.object({
  kind: z.literal('leave'), ...common,
  leaveType: name,
  startDate: isoDate,
  endDate: isoDate,
  days: z.number(),
  durationType: z.enum(['full_day', 'half_day_am', 'half_day_pm', 'hourly']),
  fromTime: clock.nullable(),
  toTime: clock.nullable(),
  hours: z.number().nullable(),
  /** The employee's own remark on the application. */
  employeeReason: z.string().max(2000).nullable(),
  hasDocument: z.boolean(),
  /** Per-date approval: each requested date and its state. Empty ⇒ the request is decided whole. */
  dates: z.array(z.object({ date: isoDate, days: z.number(), status: z.enum(['pending', 'approved', 'rejected']) })).max(400),
  expected: leaveExpected,
  /** Null when the caller has no team access (the field is absent from their view, not empty). */
  teamCover: TeamCoverV2.nullable(),
});
export const LeaveCancellationTaskDetailV2 = z.object({
  kind: z.literal('leaveCancellation'), ...common,
  leaveType: name,
  originalStart: isoDate,
  originalEnd: isoDate,
  cancelDates: z.array(isoDate).max(400),
  requestedDays: z.number(),
  employeeReason: z.string().max(2000).nullable(),
  expected: leaveExpected,
});
export const AttendanceTaskDetailV2 = z.object({
  kind: z.literal('attendance'), ...common,
  /** lib/approvals-bulk.ts isOvertimeCorrection: a self overtime application, else a clock correction. */
  application: z.enum(['correction', 'overtime']),
  date: isoDate,
  proposedCheckIn: clock.nullable(),
  proposedCheckOut: clock.nullable(),
  plannedStart: clock.nullable(),
  plannedEnd: clock.nullable(),
  requestedOtMinutes: z.number().int().nullable(),
  /** Overtime only: the kind of day asked for (core/attendance dayTypesForPairs). */
  dayType: z.enum(['workday', 'rest_day', 'holiday']).nullable(),
  employeeReason: z.string().max(2000).nullable(),
  hasAttachment: z.boolean(),
  expected: attendanceExpected,
  /**
   * The web approver's "Original clock times": the attendance record's first in / last out as the kernel captured
   * them when the employee asked (attendance_correction.original_clock_snapshot), shown read-only. Present only
   * where the web shows it (a clock correction); null otherwise. `not_captured`: the request predates the
   * snapshot; `no_record`: there was no attendance record that day. Optional for older servers.
   */
  original: z.object({ state: z.enum(['recorded', 'no_record', 'not_captured']), checkIn: clock.nullable(), checkOut: clock.nullable() }).nullable().optional(),
  /** A clock-data correction's proposed clockings (the web's "Proposed" list), in the order asked; null when none. */
  proposedPunches: z.array(z.object({ at: clock, direction: z.enum(['in', 'out']) })).max(100).nullable().optional(),
});
/** D12 — a pending expense claim as listPendingClaims reads it. Amounts are two-place decimal strings. */
export const ClaimTaskDetailV2 = z.object({
  kind: z.literal('claim'), ...common,
  claimType: name,
  claimItem: name.nullable(),
  amount: MoneyV2,
  /** The claimant's company's one currency (claims carry none of their own), or null. */
  currency: z.string().max(8).nullable(),
  quantityKm: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).nullable(),
  incurredOn: isoDate,
  /** The employee's own description of the expense. */
  employeeReason: z.string().max(2000).nullable(),
  fields: z.array(ClaimFieldAnswerV2).max(100),
  /** Each opens through GET …/tasks/claim/{id}/document?attachment={receipt id}. */
  receipts: z.array(ClaimReceiptV2).max(50),
  expected: claimExpected,
});
export const TaskDetailV2 = z.discriminatedUnion('kind', [LeaveTaskDetailV2, LeaveCancellationTaskDetailV2, AttendanceTaskDetailV2, ClaimTaskDetailV2]);
export type TaskDetailV2 = z.infer<typeof TaskDetailV2>;

/**
 * Admission refusals, answered the same whether the item is another tenant's, another company's, a guessed id or
 * simply no longer this caller's: `not_assigned`. `self_approval` (D4) and `already_decided` are told only about
 * a row the caller can already read through the canonical reader.
 */
export const TASK_ADMISSION_REFUSALS = ['not_assigned', 'self_approval', 'already_decided'] as const;
export const TaskAdmissionRefusal = refusalOf(TASK_ADMISSION_REFUSALS);
export type TaskAdmissionRefusal = z.infer<typeof TaskAdmissionRefusal>;
export const TaskDetailResult = z.union([z.object({ outcome: z.literal('found'), task: TaskDetailV2 }), TaskAdmissionRefusal]);
export type TaskDetailResult = z.infer<typeof TaskDetailResult>;

/** `unsupported_document`: stored in a type the phone is not sent (open it on the web). */
export const TaskDocumentRefusal = refusalOf([...TASK_ADMISSION_REFUSALS, 'no_document', 'unsupported_document']);
export type TaskDocumentRefusal = z.infer<typeof TaskDocumentRefusal>;

/**
 * The decision. `dates` (per-date leave only): the pending dates to APPROVE with `decision: 'approve'`; every other
 * pending date is rejected with `reason`. Omitted ⇒ every pending date takes `decision`. `expected` is the
 * detail's `expected`, verbatim; a moved step/stage is `stale_step` and the app refetches.
 */
export const TaskDecisionCommand = commandOf({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(1000).optional(),
  dates: z.array(calendarDate).min(1).max(400).optional(),
  expected: z.union([leaveExpected.strict(), attendanceExpected.strict(), claimExpected.strict()]),
});
export type TaskDecisionCommand = z.infer<typeof TaskDecisionCommand>;

/**
 * `decision_refused`: any other refusal a canonical decider raised, with its own sentence (English) when its class
 * is on the allowlist (core/mobile-approvals.ts decisionRefusal); `employment_required`: the caller has no own
 * employment to decide under; `request_conflict`: the requestId already recorded a different decision.
 */
export const TASK_DECISION_REFUSALS = [...TASK_ADMISSION_REFUSALS, 'reason_required', 'stale_step', 'request_conflict', 'employment_required', 'decision_refused'] as const;
export type TaskDecisionRefusalCode = (typeof TASK_DECISION_REFUSALS)[number];
export const TaskDecisionRefusal = refusalOf(TASK_DECISION_REFUSALS);
export type TaskDecisionRefusal = z.infer<typeof TaskDecisionRefusal>;
/** `pending_next_step`: this level is recorded and the request waits at the next one. */
export const TaskDecisionResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), status: z.enum(['approved', 'rejected', 'pending_next_step']) }),
  TaskDecisionRefusal,
]);
export type TaskDecisionResult = z.infer<typeof TaskDecisionResult>;
