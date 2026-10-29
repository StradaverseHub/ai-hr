/**
 * M07 — native leave history, detail and the two employee commands (withdraw, cancel dates). v2 only: every
 * shape here is new, and v1's enums are closed (common.ts). Imported by route handlers AND by the Expo app, so
 * this file stays dependency-free (zod and common.ts only, no server module, no 'server-only').
 *
 * Nothing here is a leave rule. Statuses, per-date outcomes, approval levels, the cancellable dates and the
 * actions offered are computed on the server by the owners the web's own history uses (core/mobile-leave-history.ts
 * says which); the app renders them and never derives one.
 *
 *   GET  /api/mobile/v2/leave/requests?employmentId&status&from&to&cursor&limit  → LeaveRequestsPageV2
 *   GET  /api/mobile/v2/leave/requests/{id}?employmentId                         → LeaveRequestDetailResult
 *   POST /api/mobile/v2/leave/requests/{id}/withdraw?employmentId     {requestId}  → LeaveWithdrawResult
 *   POST /api/mobile/v2/leave/requests/{id}/cancellation?employmentId {requestId, cancelDates[], reason?}
 *                                                                                → LeaveCancellationResult
 */
import { z } from 'zod';
import { commandOf, pageOf, refusalOf } from './common';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const calendarDate = isoDate.refine((v) => { const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
const instant = z.string().max(40);
const name = z.string().max(300);

/** The four stored statuses, the history's filter chips (lib/my-leave-history.ts LEAVE_HISTORY_TABS). */
export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const LeaveRequestStatus = z.enum(LEAVE_REQUEST_STATUSES);
/** What the employee reads (lib/my-leave-history.ts ownLeaveStatusKey); `partial` and `cancellation_pending` are display-only. */
export const LeaveDisplayStatus = z.enum(['pending', 'approved', 'partial', 'rejected', 'cancelled', 'cancellation_pending']);
export type LeaveDisplayStatus = z.infer<typeof LeaveDisplayStatus>;
const duration = z.enum(['full_day', 'half_day_am', 'half_day_pm', 'hourly']);

export const LeaveRequestSummaryV2 = z.object({
  id: z.string().uuid(),
  leaveType: name,
  startDate: isoDate,
  endDate: isoDate,
  days: z.number(),
  durationType: duration,
  status: LeaveRequestStatus,
  displayStatus: LeaveDisplayStatus,
});
export type LeaveRequestSummaryV2 = z.infer<typeof LeaveRequestSummaryV2>;
/** Keyset tuple: the last row's start date and id (core/read.ts listLeaveRequestsPage `before`). */
export const LEAVE_REQUESTS_CURSOR = 'leave.requests';
export const LeaveRequestsCursor = z.tuple([isoDate, z.string().uuid()]);
export const LeaveRequestsPageV2 = pageOf(LeaveRequestSummaryV2).extend({
  employmentId: z.string().uuid().nullable(),
  /** Per stored status under the same type/date filter, ignoring the status filter (the chips' badges). */
  counts: z.object({ pending: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }),
});
export type LeaveRequestsPageV2 = z.infer<typeof LeaveRequestsPageV2>;

export const LeaveDateOutcomeV2 = z.object({
  date: isoDate,
  status: z.enum(['approved', 'rejected', 'pending', 'cancelled']),
  reason: z.string().max(2000).nullable(),
});
/**
 * One approval level. `status`: approved / rejected (decided), waiting (the level the request waits at), or
 * not_reached. `kindLabel` is the server-translated approver kind ("Manager", "HR"), null for an unknown kind.
 * `names`: who decided it (decided levels), or who it waits for. `decidedAt` is an instant.
 */
export const LeaveApprovalLevelV2 = z.object({
  level: z.number().int().positive(),
  kindLabel: name.nullable(),
  status: z.enum(['approved', 'rejected', 'waiting', 'not_reached']),
  names: z.array(name).max(20),
  decidedAt: instant.nullable(),
});
export const LeaveRequestDetailV2 = z.object({
  id: z.string().uuid(),
  leaveType: name,
  startDate: isoDate,
  endDate: isoDate,
  days: z.number(),
  durationType: duration,
  fromTime: z.string().max(8).nullable(),
  toTime: z.string().max(8).nullable(),
  status: LeaveRequestStatus,
  displayStatus: LeaveDisplayStatus,
  /** Tenant-local date the application was submitted; null when a split row's lineage was not recorded. */
  appliedOn: isoDate.nullable(),
  reason: z.string().max(2000).nullable(),
  /** Per-date outcome, ascending. Empty when the request carries no per-date record. */
  dates: z.array(LeaveDateOutcomeV2).max(400),
  approvals: z.array(LeaveApprovalLevelV2).max(20),
  /** A rejected request: the approver's words, or each rejected date's own reason. */
  rejection: z.object({ reason: z.string().max(2000).nullable(), dates: z.array(z.object({ date: isoDate, reason: z.string().max(2000).nullable() })).max(400) }).nullable(),
  /** A cancelled request: when, by whom (or automatically), and the reason on record. */
  cancellation: z.object({ cancelledAt: instant.nullable(), cancelledByName: name.nullable(), automatic: z.boolean(), reason: z.string().max(2000).nullable() }).nullable(),
  /** A give-back waiting for approval: when it was asked, the dates, each copied level's state. */
  pendingCancellation: z.object({
    requestedAt: instant,
    cancelDates: z.array(isoDate).max(400),
    levels: z.array(z.object({ level: z.number().int().positive(), status: z.enum(['approved', 'waiting', 'not_reached']) })).max(20),
  }).nullable(),
  /** What the employee may do now, from the web's own predicates. `cancelDates` null ⇒ no Cancel dates action. */
  actions: z.object({ withdraw: z.boolean(), cancelDates: z.array(isoDate).max(400).nullable() }),
});
export type LeaveRequestDetailV2 = z.infer<typeof LeaveRequestDetailV2>;
export const LeaveRequestNotFound = refusalOf(['not_found']);
export const LeaveRequestDetailResult = z.union([z.object({ outcome: z.literal('found'), request: LeaveRequestDetailV2 }), LeaveRequestNotFound]);
export type LeaveRequestDetailResult = z.infer<typeof LeaveRequestDetailResult>;

/**
 * Command refusals. The cancellation family is core/leave.ts LeaveCancellationRefusal (the codes the web already
 * localises), plus the typed cancellation errors beside it and the payroll lock; `cancellation_refused` is any
 * other leave-domain refusal (message carried); `not_found` the row is not the caller's own selected employment's;
 * `request_conflict` the requestId already recorded a different command.
 */
export const LEAVE_COMMAND_REFUSALS = [
  'not_found', 'request_conflict', 'not_yours', 'not_approved', 'not_full_day', 'grouped', 'type_off', 'unpaid_days',
  'already_pending', 'no_longer_cancellable', 'already_final', 'already_approved', 'too_close', 'too_late',
  'date_invalid', 'credit_blocked', 'payroll_closed', 'payroll_busy', 'cancellation_refused',
] as const;
export type LeaveCommandRefusalCode = (typeof LEAVE_COMMAND_REFUSALS)[number];
export const LeaveCommandRefusal = refusalOf(LEAVE_COMMAND_REFUSALS);
export type LeaveCommandRefusal = z.infer<typeof LeaveCommandRefusal>;

export const LeaveWithdrawCommand = commandOf({});
export type LeaveWithdrawCommand = z.infer<typeof LeaveWithdrawCommand>;
export const LeaveWithdrawResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('withdrawn'), id: z.string().uuid() }),
  LeaveCommandRefusal,
]);
export type LeaveWithdrawResult = z.infer<typeof LeaveWithdrawResult>;

export const LeaveCancellationCommand = commandOf({
  cancelDates: z.array(calendarDate).min(1).max(400),
  reason: z.string().trim().max(2000).optional(),
});
export type LeaveCancellationCommand = z.infer<typeof LeaveCancellationCommand>;
/** `approved`: the leave type approves cancellations automatically and the days are back; `pending`: it waits. */
export const LeaveCancellationResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), id: z.string().uuid(), cancellationRequestId: z.string().uuid(), status: z.enum(['approved', 'pending']), requestedDays: z.number() }),
  LeaveCommandRefusal,
]);
export type LeaveCancellationResult = z.infer<typeof LeaveCancellationResult>;
