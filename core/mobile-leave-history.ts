/**
 * M07 — the native leave history, detail and the employee's two commands on a request (withdraw a pending one,
 * cancel dates of an approved one). COMPOSITION ONLY: every fact comes from the owner the web's own history
 * (components/leave/own-leave-history.tsx loadOwnLeaveHistory) already reads, and every command is the service
 * the web's action calls. Nothing here decides a leave rule.
 *
 *   list     listLeaveRequestsPage (start-desc keyset) + countLeaveRequestsByStatus, ownLeaveApprovalTrails
 *   detail   leaveRequestDateBreakdown · employeeCancelOffers · pendingCancellationProgress ·
 *            ownLeaveApprovalTrails / ownLeaveCancellations / ownLeaveRejections · lib/my-leave-history predicates
 *   withdraw cancelOwnLeave, in the mobile command receipt's transaction (D5(a))
 *   cancel   requestLeaveCancellation with todayInKualaLumpur(), in the receipt's transaction (D5(a))
 *
 * SCOPE. `employmentId` is the caller's OWN selected employment, already verified by the route
 * (lib/mobile-api/request.ts mobileEmployment). Every read narrows to it in SQL, so a row RLS would show a
 * manager (a subordinate's request) is simply absent here: `not_found`, never a subordinate's data. The services
 * re-assert "only the employee" themselves.
 *
 * A REFUSAL ROLLS BACK. A leave service that refuses throws, and the throw must abort its transaction (it may
 * have locked or written before deciding), so a refusal is mapped AFTER withMobileCommandReceipt, records no
 * receipt, and a retry re-evaluates it. Only an accepted command is recorded and replayed.
 *
 * Kept free of 'server-only' (mobile-command-receipt.ts says why).
 */
import type { z } from 'zod';
import type { SessionContext } from '../db/client';
import { countLeaveRequestsByStatus, employeeCancelOffers, leaveRequestDateBreakdown, listLeaveRequestsPage, pendingCancellationProgress } from './read';
import { ownLeaveApprovalTrails, ownLeaveCancellations, ownLeaveRejections, type OwnApprovalTrail } from './my-leave';
import { withMobileCommandReceipt } from './mobile-command-receipt';
import * as leave from '../packs/leave/service';
import { LeavePayrollBusyError, LeavePayrollClosedError } from '../packs/payroll/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { publicErrorMessage } from '../lib/public-error';
import { applicationDateOutcomeRows, approverKindLabelKey, ownLeaveStatusKey, ownLeaveWithdrawable, pendingApprovalLine } from '../lib/my-leave-history';
import { encodeCursor } from '../lib/mobile-api/v2/common';
import {
  LEAVE_COMMAND_REFUSALS, LEAVE_REQUESTS_CURSOR, LEAVE_REQUEST_STATUSES, LeaveCancellationResult, LeaveWithdrawResult,
  type LeaveCommandRefusal, type LeaveCommandRefusalCode, type LeaveDisplayStatus, type LeaveRequestDetailResult,
  type LeaveRequestDetailV2, type LeaveRequestsPageV2, type LeaveRequestSummaryV2,
} from '../lib/mobile-api/v2/leave';

type Row = Awaited<ReturnType<typeof listLeaveRequestsPage>>['rows'][number];
type Status = (typeof LEAVE_REQUEST_STATUSES)[number];
/** The approver kind's server-translated label (leaveApproval.*), or null. Injected so core stays catalogue-free. */
export type KindLabel = (labelKey: string) => string | null;

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : (d instanceof Date ? d : new Date(String(d))).toISOString());
const durationOf = (v: string | null) => (v === 'half_day_am' || v === 'half_day_pm' || v === 'hourly' ? v : 'full_day');
function displayOf(r: Row, trail: OwnApprovalTrail | undefined): LeaveDisplayStatus {
  const key = ownLeaveStatusKey(r, trail);
  return key === 'pendingCancellation' ? 'cancellation_pending' : (key as LeaveDisplayStatus);
}
function summaryOf(r: Row, trail: OwnApprovalTrail | undefined): LeaveRequestSummaryV2 {
  return { id: r.id, leaveType: r.leaveType, startDate: r.startDate, endDate: r.endDate, days: Number(r.days), durationType: durationOf(r.durationType), status: r.status as Status, displayStatus: displayOf(r, trail) };
}

/** One page of the caller's own requests on one employment, newest leave start first. */
export async function ownLeaveRequestsPage(
  ctx: SessionContext,
  employmentId: string,
  q: { status?: Status; from?: string; to?: string; limit: number; cursor: readonly [string, string] | null },
): Promise<LeaveRequestsPageV2> {
  const filter = { employmentIds: [employmentId], from: q.from, to: q.to };
  const page = await listLeaveRequestsPage(ctx, {
    ...filter, statuses: q.status ? [q.status] : undefined, sort: 'start', dir: 'desc', limit: q.limit + 1, offset: 0,
    before: q.cursor ? { startDate: q.cursor[0], id: q.cursor[1] } : undefined,
  });
  const byStatus = await countLeaveRequestsByStatus(ctx, { ...filter, statuses: [...LEAVE_REQUEST_STATUSES] });
  const rows = page.rows.slice(0, q.limit);
  const trails = rows.length ? await ownLeaveApprovalTrails(ctx, rows.map((r) => r.id)) : new Map<string, OwnApprovalTrail>();
  const last = rows[rows.length - 1];
  return {
    employmentId,
    items: rows.map((r) => summaryOf(r, trails.get(r.id))),
    nextCursor: page.rows.length > q.limit && last ? encodeCursor(LEAVE_REQUESTS_CURSOR, [last.startDate, last.id]) : null,
    counts: { pending: byStatus.pending ?? 0, approved: byStatus.approved ?? 0, rejected: byStatus.rejected ?? 0, cancelled: byStatus.cancelled ?? 0 },
  };
}

/** The row, only when it belongs to `employmentId` (the caller's own, verified upstream). */
async function ownRow(ctx: SessionContext, employmentId: string, id: string): Promise<Row | null> {
  const { rows } = await listLeaveRequestsPage(ctx, { employmentIds: [employmentId], ids: [id], limit: 1, offset: 0 });
  return rows[0] ?? null;
}

/**
 * The approval levels as the employee reads them — the structure lib/my-leave-history.ts approvalProgress prints
 * for the web's View panel, as data: decided levels name who decided and when; the level a pending request waits
 * at names who it waits for; a single-level chain has no step rows and is level 1 of 1.
 */
function approvalLevels(r: Row, trail: OwnApprovalTrail | undefined, kindLabel: KindLabel): LeaveRequestDetailV2['approvals'] {
  const label = (kind: string | null) => { const key = approverKindLabelKey(kind); return key ? kindLabel(key) : null; };
  if (!trail) return [];
  if (trail.lineage === 'unrecorded') {
    return trail.decidedByName && (r.status === 'approved' || r.status === 'cancelled')
      ? [{ level: 1, kindLabel: null, status: 'approved', names: [trail.decidedByName], decidedAt: iso(trail.decidedAt) }] : [];
  }
  const steps = [...trail.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  if (steps.length > 0) {
    const firstPending = r.status === 'pending' ? steps.findIndex((s) => s.status === 'pending') : -1;
    return steps.map((s, i) => s.status === 'approved' || s.status === 'rejected'
      ? { level: i + 1, kindLabel: label(s.kind), status: s.status, names: s.decidedByName ? [s.decidedByName] : [], decidedAt: iso(s.decidedAt) }
      : { level: i + 1, kindLabel: label(s.kind), status: i === firstPending ? 'waiting' : 'not_reached', names: [s.approverName, ...s.alternateNames].filter((n): n is string => !!n), decidedAt: null });
  }
  if (r.status === 'pending') {
    const line = pendingApprovalLine(trail);
    return [{ level: 1, kindLabel: label(line?.kind ?? null), status: 'waiting', names: line?.names ?? [], decidedAt: null }];
  }
  if (trail.decidedAt) {
    return [{ level: 1, kindLabel: null, status: r.status === 'rejected' ? 'rejected' : 'approved', names: trail.decidedByName ? [trail.decidedByName] : [], decidedAt: iso(trail.decidedAt) }];
  }
  return [];
}

/** One of the caller's own requests on `employmentId`, with everything the web's View panel shows. */
export async function ownLeaveRequestDetail(ctx: SessionContext, employmentId: string, id: string, kindLabel: KindLabel): Promise<LeaveRequestDetailResult> {
  const r = await ownRow(ctx, employmentId, id);
  if (!r) return { outcome: 'refused', code: 'not_found' };
  const today = todayInKualaLumpur();
  const [breakdown, offers, progress, trails, cancellations, rejections] = await Promise.all([
    leaveRequestDateBreakdown(ctx, r.id),
    employeeCancelOffers(ctx, [r], today),
    r.status === 'approved' && r.pendingCancellationId ? pendingCancellationProgress(ctx, [r.pendingCancellationId]) : Promise.resolve(new Map()),
    ownLeaveApprovalTrails(ctx, [r.id]),
    r.status === 'cancelled' ? ownLeaveCancellations(ctx, [r.id]) : Promise.resolve(new Map()),
    r.status === 'rejected' ? ownLeaveRejections(ctx, [r.id]) : Promise.resolve(new Map()),
  ]);
  const trail = trails.get(r.id);
  // The web's rule: the application's per-date outcome when there is one, else this row's own per-date record.
  const dates = trail?.perDateOutcome
    ? applicationDateOutcomeRows(trail.perDateOutcome).map((d) => ({ date: d.leaveDate, status: d.status, reason: d.rejectReason }))
    : breakdown.map((d) => ({ date: d.leaveDate, status: d.status, reason: d.rejectReason ?? null }));
  const rejection = rejections.get(r.id);
  const cancellation = cancellations.get(r.id);
  const pending = progress.get(r.pendingCancellationId ?? '');
  const firstWaiting = pending?.levels.find((l: { status: string }) => l.status === 'pending')?.stepIndex ?? null;
  const withdraw = ownLeaveWithdrawable(r);
  const hourly = r.durationType === 'hourly';
  return {
    outcome: 'found',
    request: {
      ...summaryOf(r, trail),
      fromTime: hourly && r.fromTime ? r.fromTime.slice(0, 5) : null,
      toTime: hourly && r.toTime ? r.toTime.slice(0, 5) : null,
      appliedOn: trail?.lineage === 'unrecorded' ? null : todayInKualaLumpur(trail?.submittedAt ?? new Date(r.appliedOn)),
      reason: r.reason ?? null,
      dates,
      approvals: approvalLevels(r, trail, kindLabel),
      rejection: rejection ? { reason: rejection.reason, dates: rejection.dates } : null,
      cancellation: cancellation ? { cancelledAt: iso(cancellation.cancelledAt), cancelledByName: cancellation.cancelledByName, automatic: cancellation.automatic, reason: cancellation.reason } : null,
      pendingCancellation: pending ? {
        requestedAt: iso(pending.requestedAt)!,
        cancelDates: pending.cancelDates,
        levels: pending.levels.map((l: { stepIndex: number; status: string }, i: number) => ({ level: i + 1, status: l.status === 'approved' ? 'approved' : l.stepIndex === firstWaiting ? 'waiting' : 'not_reached' })),
      } : null,
      // The web offers Edit/Withdraw on a withdrawable row and otherwise the Cancel dates offer (null ⇒ none).
      actions: { withdraw, cancelDates: withdraw ? null : (offers.get(r.id) ?? null) },
    },
  };
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────

const NOT_FOUND = { outcome: 'refused', code: 'not_found' } as const;
const KNOWN = new Set<string>(LEAVE_COMMAND_REFUSALS);
/** The leave pack's own refusal classes, by the export-name allowlist the v1 submit route uses. */
const isLeaveDomainError = (e: unknown) => Object.entries(leave).some(([n, v]) =>
  /^(Leave|ReplacementCredit|InsufficientLeave|NegativeLeave|HourlyLeave|MissingReject).*Error$/.test(n) && typeof v === 'function' && e instanceof (v as typeof Error));

/** A leave service refusal as its v2 code (+ the domain's own sentence); anything else is rethrown (a 500). */
export function leaveCommandRefusal(e: unknown): LeaveCommandRefusal {
  const refuse = (code: LeaveCommandRefusalCode): LeaveCommandRefusal => ({ outcome: 'refused', code, message: publicErrorMessage(e).slice(0, 4000) });
  if (e instanceof leave.LeaveCancellationTooCloseError) return refuse('too_close');
  if (e instanceof leave.LeaveCancellationTooLateError) return refuse('too_late');
  if (e instanceof leave.LeaveCancellationDateInvalidError) return refuse('date_invalid');
  if (e instanceof leave.LeaveCancellationPeriodClosedError || e instanceof LeavePayrollClosedError) return refuse('payroll_closed');
  if (e instanceof LeavePayrollBusyError) return refuse('payroll_busy');
  if (e instanceof leave.ReplacementCreditCancellationBlockedError) return refuse('credit_blocked');
  if (e instanceof leave.LeaveCancellationNotAllowedError) return refuse(e.refusal && KNOWN.has(e.refusal) ? (e.refusal as LeaveCommandRefusalCode) : 'cancellation_refused');
  if (isLeaveDomainError(e)) return refuse('cancellation_refused');
  throw e;
}

async function command<S extends z.ZodType>(run: () => Promise<z.output<S>>): Promise<z.output<S> | LeaveCommandRefusal> {
  try { return await run(); } catch (e) { return leaveCommandRefusal(e); }
}

/** Withdraw the caller's own PENDING request (cancelOwnLeave). Replays its first accepted answer. */
export async function withdrawOwnLeaveV2(ctx: SessionContext, employmentId: string, leaveRequestId: string, requestId: string): Promise<z.output<typeof LeaveWithdrawResult>> {
  const id = leaveRequestId.toLowerCase();
  if (!(await ownRow(ctx, employmentId, id))) return NOT_FOUND;
  return command<typeof LeaveWithdrawResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'leave.withdraw', requestId, intent: { leaveRequestId: id }, actorEmploymentId: employmentId, response: LeaveWithdrawResult,
  }, async (tx) => {
    await leave.cancelOwnLeave(ctx, { leaveRequestId: id }, tx);
    return { outcome: 'withdrawn' as const, id };
  }));
}

/** Ask to give back dates of the caller's own APPROVED request (requestLeaveCancellation). approved | pending. */
export async function cancelOwnLeaveDatesV2(
  ctx: SessionContext, employmentId: string, leaveRequestId: string,
  p: { requestId: string; cancelDates: readonly string[]; reason?: string },
): Promise<z.output<typeof LeaveCancellationResult>> {
  const id = leaveRequestId.toLowerCase();
  if (!(await ownRow(ctx, employmentId, id))) return NOT_FOUND;
  const cancelDates = [...new Set(p.cancelDates)].sort();
  const reason = p.reason?.trim() || undefined;
  return command<typeof LeaveCancellationResult>(() => withMobileCommandReceipt(ctx, {
    kind: 'leave.cancellation', requestId: p.requestId, intent: { leaveRequestId: id, cancelDates, reason: reason ?? null }, actorEmploymentId: employmentId, response: LeaveCancellationResult,
  }, async (tx) => {
    const out = await leave.requestLeaveCancellation(ctx, { leaveRequestId: id, cancelDates, reason, today: todayInKualaLumpur() }, tx);
    return { outcome: 'accepted' as const, id, cancellationRequestId: out.cancellationRequestId, status: out.status, requestedDays: out.requestedDays };
  }));
}
