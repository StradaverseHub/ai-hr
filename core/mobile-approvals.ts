/**
 * M08 — the approver's native task list, one task's facts, its supporting document and the decision. COMPOSITION
 * ONLY: assignment, visibility, authority and every decision belong to the owners the web inbox
 * (app/(app)/approvals/page.tsx, app/(app)/approvals/actions.ts) already uses. Nothing here decides an approval rule.
 *
 *   list       listPendingTasks (every kind, the inbox's own order), keyset-paged in memory
 *   admission  isCurrentAssignedApproval (core/assigned-approval-focus.ts) — a URL cannot supply assignment
 *   leave      listLeaveRequests {status:'pending', requestId} · leaveRequestDateBreakdown · decideLeave (whole) or
 *              decideLeaveDates (a per-date request), with expectedStepIndex, in the receipt's transaction
 *   cancel     listPendingLeaveCancellations {requestId} · decideLeaveCancellation, expectedStepIndex, same tx
 *   attendance listAttendanceCorrections {status:'pending', requestId} (canDecide, workflow stage/slot) ·
 *              dayTypesForPairs (overtime) · decideAttendanceCorrection, expectedStageIndex/ParticipantSlot, same tx.
 *              OVERTIME IS AN ATTENDANCE APPLICATION: a self-overtime / Plan OT request is an attendance_correction
 *              with requested_ot_minutes (lib/approvals-bulk.ts isOvertimeCorrection), decided by that one decider.
 *   cover      resolveMyTeamScope + myTeamLeaveProjection, as the v1 team route reads them (names, dates, status)
 *   document   getLeaveAttachment, after the same admission
 *   claim      (D12, M11) listPendingClaims {requestId} + claimRecordFacts (custom answers) · getClaimAttachment for
 *              one of its receipts · decideClaim (one step: pending → approved | rejected, the rejection reason stamped
 *              on its event), in the receipt's transaction. A claim has no chain, so its expected state is `pending`.
 *
 * ADMISSION (D4). Self-approval is refused before any decider runs, even for super_admin, whom the kernel would
 * let decide their own request (core/approvals.ts assertCanDecide). An item that is not the caller's current
 * assignment is `not_assigned` whatever the reason — another tenant's, another company's, a guessed id, a
 * changed manager, an expired delegation, a reassigned stage. Only for a row the caller can already read under
 * RLS does the answer say more: their own (`self_approval`) or no longer pending (`already_decided`).
 *
 * THE DECIDER'S EMPLOYMENT is the caller's own (myEmployment), never the client's. It is also the receipt's
 * subject (core/mobile-command-receipt.ts says why).
 *
 * A REFUSAL ROLLS BACK. Admission refusals and every decider refusal are thrown inside the receipt's run and
 * mapped after it, so nothing is recorded and a retry re-evaluates; only an accepted decision is recorded and
 * replayed (a lost answer, retried with the same requestId, gets the first answer — even though the item has
 * left the caller's list by then, because the receipt is read before admission is consulted).
 *
 * Kept free of 'server-only' (mobile-command-receipt.ts says why).
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { attendanceCorrection, claimRequest, employment, leaveCancellationRequest, leaveRequest, leaveRequestDate } from '../db/schema';
import { listPendingTasks } from './approvals-inbox';
import { isCurrentAssignedApproval } from './assigned-approval-focus';
import { isApprovalDecisionRefusal } from './approvals';
import { isModuleEnabled } from './entitlements';
import { MyTeamAuthorizationError, resolveMyTeamScope } from './my-team-scope';
import { leaveRequestDateBreakdown, listLeaveRequests, listPendingLeaveCancellations, myEmployment } from './read';
import { MobileCommandOwnerRequired, withMobileCommandReceipt } from './mobile-command-receipt';
import * as leave from '../packs/leave/service';
import * as claims from '../packs/claims/service';
import { claimAnswers, currenciesOfClaims, currencyOfClaim, decimalText, receiptFile } from './mobile-claims';
import { moneyText } from '../lib/mobile-api/money-text';
import { dayTypesForPairs, decideAttendanceCorrection, listAttendanceCorrections, MissingAttendanceRejectReasonError } from '../packs/attendance/service';
import { LeavePayrollBusyError, LeavePayrollClosedError } from '../packs/payroll/service';
import { AttendanceWorkflowError } from '../lib/attendance-workflow';
import { AttendanceLevelError } from '../lib/attendance-workflow-v3';
import { isOvertimeCorrection } from '../lib/approvals-bulk';
import { hasTeamAccess } from '../lib/authz-model';
import { isDatabaseError } from '../lib/db-error';
import { publicErrorMessage } from '../lib/public-error';
import { todayInKualaLumpur } from '../lib/hr-date';
import { hasMobileBinarySignature, isMobileBinaryType, MOBILE_ATTACHMENT_TYPES, type MobileBinaryType } from '../lib/mobile-api/binary-types';
import { encodeCursor } from '../lib/mobile-api/v2/common';
import {
  isNativeTaskKind, TASKS_CURSOR, TaskDecisionResult,
  type NativeTaskKind, type TaskAdmissionRefusal, type TaskDecisionCommand, type TaskDecisionRefusal, type TaskDecisionRefusalCode,
  type TaskDetailResult, type TaskDocumentRefusal, type TaskKind, type TaskSummaryV2, type TasksPageV2, type TeamCoverV2,
} from '../lib/mobile-api/v2/tasks';

type AdmissionCode = TaskAdmissionRefusal['code'];
const refused = <C extends string>(code: C) => ({ outcome: 'refused' as const, code });
/** A refusal raised inside the receipt's run, so the transaction rolls back and nothing is recorded. */
class TaskRefused extends Error {
  constructor(readonly code: TaskDecisionRefusalCode) { super(code); this.name = 'TaskRefused'; }
}
const modulesOf = (ctx: SessionContext) => ({ attendance: isModuleEnabled(ctx, 'attendance'), claims: isModuleEnabled(ctx, 'claims'),
  performance: isModuleEnabled(ctx, 'performance'), rewards: isModuleEnabled(ctx, 'rewards') });
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const hhmm = (v: unknown): string | null => (typeof v === 'string' && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
const num = (v: unknown): number => Number(v ?? 0);

// ── List ───────────────────────────────────────────────────────────────────────────────────────────────────

type Pending = Awaited<ReturnType<typeof listPendingTasks>>[number];
/** The inbox's own order (core/approvals-inbox.ts): createdAt desc, then kind, then id. */
const order = (a: { createdAt: string; kind: string; id: string }, b: { createdAt: string; kind: string; id: string }) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

const summaryOf = (over: Partial<TaskSummaryV2>): TaskSummaryV2 => ({ label: null, from: null, to: null, days: null, amount: null, currency: null, ...over });
const label = (v: string | null | undefined) => (v ? v.slice(0, 300) : null);

/**
 * Each native row's summary, from the readers app/(app)/approvals/page.tsx lists those rows with (same session, same RLS,
 * same pending filter), and only the columns that page prints. One read per kind present on the page; a row the
 * reader does not return for this caller gets no summary, so the list never says more than the web page would.
 */
async function summariesFor(ctx: SessionContext, rows: readonly Pending[], locale: string): Promise<Map<string, TaskSummaryV2>> {
  const ids = (kind: NativeTaskKind) => new Set(rows.filter((r) => r.kind === kind).map((r) => r.id));
  const leaveIds = ids('leave'), cancelIds = ids('leaveCancellation'), attendanceIds = ids('attendance'), claimIds = ids('claim');
  const modules = modulesOf(ctx);
  // A summary is a convenience on a row the inbox already lists: a reader that fails leaves its rows without one
  // (the row and its detail still open), it never turns the whole list into an error or an empty "nothing needs you".
  const orNone = <T,>(read: () => Promise<T[]>): Promise<T[]> => read().catch(() => []);
  const [leaves, cancels, corrections, pendingClaims] = await Promise.all([
    leaveIds.size ? orNone(() => listLeaveRequests(ctx, undefined, 200, { status: 'pending' })) : Promise.resolve([]),
    cancelIds.size ? orNone(() => listPendingLeaveCancellations(ctx, undefined, locale)) : Promise.resolve([]),
    attendanceIds.size && modules.attendance ? orNone(() => listAttendanceCorrections(ctx, { status: 'pending' })) : Promise.resolve([]),
    claimIds.size && modules.claims ? orNone(() => claims.listPendingClaims(ctx)) : Promise.resolve([]),
  ]);
  const shownClaims = pendingClaims.filter((c) => claimIds.has(c.id));
  const currencies = await currenciesOfClaims(ctx, shownClaims.map((c) => c.id)).catch(() => new Map<string, string | null>());
  const out = new Map<string, TaskSummaryV2>();
  for (const r of leaves) if (leaveIds.has(r.id)) out.set(`leave:${r.id}`, summaryOf({ label: label(r.leaveType), from: r.startDate, to: r.endDate, days: num(r.days) }));
  for (const c of cancels) if (cancelIds.has(c.id)) out.set(`leaveCancellation:${c.id}`, summaryOf({ label: label(c.leaveType), from: c.originalStart, to: c.originalEnd, days: num(c.requestedDays) }));
  for (const a of corrections) if (attendanceIds.has(a.id)) out.set(`attendance:${a.id}`, summaryOf({ from: a.attendanceDate, to: a.attendanceDate }));
  for (const c of shownClaims) {
    const amount = moneyText(c.amount);
    out.set(`claim:${c.id}`, summaryOf({ label: label(c.typeName), from: c.incurredOn, to: c.incurredOn, amount, currency: amount === null ? null : currencies.get(c.id) ?? null }));
  }
  return out;
}

/** Every pending task for the caller (replacement leave and notice acknowledgements included), one page. */
export async function tasksPageV2(ctx: SessionContext, q: { limit: number; cursor: readonly [string, TaskKind, string] | null }, locale = 'en'): Promise<TasksPageV2> {
  const all = await listPendingTasks(ctx, undefined, modulesOf(ctx));
  const at = q.cursor ? { createdAt: q.cursor[0], kind: q.cursor[1], id: q.cursor[2] } : null;
  const after = (at ? all.filter((t) => order(t, at) > 0) : all).slice(0, q.limit + 1);
  const rows = after.slice(0, q.limit), last = rows[rows.length - 1];
  const summaries = await summariesFor(ctx, rows, locale);
  return {
    items: rows.map((t: Pending) => {
      const native = isNativeTaskKind(t.kind);
      return { id: t.id, kind: t.kind, subject: { name: t.subjectName, code: null }, createdAt: t.createdAt, nativeDecision: native, webPath: native ? null : t.linkPath,
        summary: native ? summaries.get(`${t.kind}:${t.id}`) ?? null : null };
    }),
    nextCursor: after.length > q.limit && last ? encodeCursor(TASKS_CURSOR, [last.createdAt, last.kind, last.id]) : null,
  };
}

/** M14 — Home's task count: exactly the v2 list's population (the same owner, modules and kinds), not a second rule. */
export async function pendingTaskCountV2(ctx: SessionContext): Promise<number> {
  return (await listPendingTasks(ctx, undefined, modulesOf(ctx))).length;
}

// ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────

/** The row's subject employment and status as the caller's RLS shows the raw row (null: not readable). */
async function rawRowTx(tx: Tx, kind: NativeTaskKind, id: string): Promise<{ employmentId: string; status: string } | null> {
  const [row] = kind === 'leave'
    ? await tx.select({ employmentId: leaveRequest.employmentId, status: leaveRequest.status }).from(leaveRequest).where(eq(leaveRequest.id, id)).limit(1)
    : kind === 'leaveCancellation'
      ? await tx.select({ employmentId: leaveCancellationRequest.employmentId, status: leaveCancellationRequest.status }).from(leaveCancellationRequest).where(eq(leaveCancellationRequest.id, id)).limit(1)
      : kind === 'claim'
        ? await tx.select({ employmentId: claimRequest.employmentId, status: claimRequest.status }).from(claimRequest).where(eq(claimRequest.id, id)).limit(1)
        : await tx.select({ employmentId: attendanceCorrection.employmentId, status: attendanceCorrection.status }).from(attendanceCorrection).where(eq(attendanceCorrection.id, id)).limit(1);
  return row ? { employmentId: row.employmentId, status: String(row.status) } : null;
}
/** One of the caller's own employments. Own employments are always readable to their person. */
async function isOwnEmploymentTx(tx: Tx, ctx: SessionContext, employmentId: string): Promise<boolean> {
  if (!ctx.personId) return false;
  const [own] = await tx.select({ id: employment.id }).from(employment).where(and(eq(employment.id, employmentId), eq(employment.personId, ctx.personId))).limit(1);
  return !!own;
}
/** Why a non-admitted item is refused. Says more than `not_assigned` only about a row RLS already lets the caller read. */
async function classifyTx(tx: Tx, ctx: SessionContext, kind: NativeTaskKind, id: string): Promise<AdmissionCode> {
  const row = await rawRowTx(tx, kind, id);
  if (!row) return 'not_assigned';
  if (await isOwnEmploymentTx(tx, ctx, row.employmentId)) return 'self_approval';
  // A claim DRAFT is readable to a manager under RLS but was never filed: it is nobody's task, not a decided one.
  if (kind === 'claim' && row.status === 'draft') return 'not_assigned';
  return row.status === 'pending' ? 'not_assigned' : 'already_decided';
}
const classify = (ctx: SessionContext, kind: NativeTaskKind, id: string) => withTenant(ctx, (tx) => classifyTx(tx, ctx, kind, id));

/** Current assignment by the canonical owner, then D4. null = admitted. */
async function admission(ctx: SessionContext, kind: NativeTaskKind, id: string): Promise<AdmissionCode | null> {
  const modules = modulesOf(ctx);
  if (kind === 'attendance' && !modules.attendance) return 'not_assigned';
  if (kind === 'claim' && !modules.claims) return 'not_assigned';
  if (!(await isCurrentAssignedApproval(ctx, { kind, id }, modules))) return classify(ctx, kind, id);
  // D4: the owners exclude self rows today; this keeps it true if one ever stops (super_admin included).
  return (await withTenant(ctx, async (tx) => { const row = await rawRowTx(tx, kind, id); return !!row && isOwnEmploymentTx(tx, ctx, row.employmentId); })) ? 'self_approval' : null;
}

// ── Detail ─────────────────────────────────────────────────────────────────────────────────────────────────

const DURATIONS = ['full_day', 'half_day_am', 'half_day_pm', 'hourly'] as const;
const durationOf = (v: string | null) => (DURATIONS as readonly string[]).includes(v ?? '') ? (v as (typeof DURATIONS)[number]) : 'full_day';
const DATE_STATUS = ['pending', 'approved', 'rejected'] as const;

/**
 * Team members (never the subject) with leave on the requested dates, for a caller with team access — the v1
 * team route's own owners and membership. Names, dates and approved/pending only: no type, no reason.
 */
async function teamCover(ctx: SessionContext, subjectEmploymentId: string, from: string, to: string): Promise<TeamCoverV2 | null> {
  if (!hasTeamAccess(ctx)) return null;
  let scope: Awaited<ReturnType<typeof resolveMyTeamScope>>;
  try { scope = await resolveMyTeamScope(ctx, { view: 'week', scope: 'all' }); }
  catch (e) { if (e instanceof MyTeamAuthorizationError) return null; throw e; }
  const members = scope.employees.filter((e) => e.employmentId !== subjectEmploymentId);
  if (!members.length) return [];
  const rows = await leave.myTeamLeaveProjection({ ...ctx, personId: scope.principal.personId }, { employmentIds: members.map((e) => e.employmentId), from, to, today: todayInKualaLumpur() });
  return members.flatMap((m) => {
    const dates = [...new Map(rows.filter((r) => r.employmentId === m.employmentId).flatMap((r) => r.dates)
      .filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date)).map((d) => [d.date, d.status] as const)).entries()]
      .map(([date, status]) => ({ date, status }));
    return dates.length ? [{ name: m.name, dates: dates.slice(0, 400) }] : [];
  }).slice(0, 50);
}

/** One admitted task with the facts the web inbox shows for it, and what the decision must echo back. */
type Correction = Awaited<ReturnType<typeof listAttendanceCorrections>>[number];
function originalOf(snapshot: Correction['originalClockSnapshot']): { state: 'recorded' | 'no_record' | 'not_captured'; checkIn: string | null; checkOut: string | null } {
  if (snapshot == null) return { state: 'not_captured', checkIn: null, checkOut: null };
  if (snapshot.attendanceId == null) return { state: 'no_record', checkIn: null, checkOut: null };
  return { state: 'recorded', checkIn: hhmm(snapshot.originalCheckIn), checkOut: hhmm(snapshot.originalCheckOut) };
}

export async function taskDetailV2(ctx: SessionContext, kind: NativeTaskKind, id: string, locale: string): Promise<TaskDetailResult> {
  const refusal = await admission(ctx, kind, id);
  if (refusal) return refused(refusal);
  // Admitted, then gone from the pending reader (decided meanwhile, or trimmed by it): classify afresh.
  const gone = async (): Promise<TaskDetailResult> => refused(await classify(ctx, kind, id));
  if (kind === 'leave') {
    const [r] = await listLeaveRequests(ctx, undefined, 1, { status: 'pending', requestId: id });
    if (!r) return gone();
    const breakdown = await leaveRequestDateBreakdown(ctx, r.id);
    return { outcome: 'found', task: {
      kind, id: r.id, subject: { name: r.employee, code: r.employeeCode ?? null }, createdAt: iso(r.appliedOn), reasonRequiredToReject: true,
      leaveType: r.leaveType, startDate: r.startDate, endDate: r.endDate, days: num(r.days), durationType: durationOf(r.durationType),
      fromTime: r.durationType === 'hourly' ? hhmm(r.fromTime) : null, toTime: r.durationType === 'hourly' ? hhmm(r.toTime) : null,
      hours: r.hours == null ? null : Number(r.hours), employeeReason: r.reason ?? null, hasDocument: !!r.hasDocument,
      dates: breakdown.map((d) => ({ date: d.leaveDate, days: num(d.days), status: (DATE_STATUS as readonly string[]).includes(d.status) ? (d.status as (typeof DATE_STATUS)[number]) : 'pending' })),
      expected: { stepIndex: r.currentStepIndex ?? null },
      teamCover: await teamCover(ctx, r.employmentId, r.startDate, r.endDate),
    } };
  }
  if (kind === 'claim') {
    const [c] = await claims.listPendingClaims(ctx, { requestId: id });
    if (!c) return gone();
    const [facts, currency] = await Promise.all([claims.claimRecordFacts(ctx, [c.id]), currencyOfClaim(ctx, c.id)]);
    const f = facts.get(c.id);
    const amount = moneyText(c.amount);
    if (amount === null) throw new Error('Claim amount is not a recorded amount');
    return { outcome: 'found', task: {
      kind, id: c.id, subject: { name: c.claimantName ?? null, code: c.employeeCode ?? null }, createdAt: f?.submittedAt ?? iso(c.createdAt),
      // D12: the app asks a reason to reject; decideClaim stamps it on the rejection event (the web asks none).
      reasonRequiredToReject: true,
      claimType: c.typeName.slice(0, 300), claimItem: c.itemName?.slice(0, 300) ?? null, amount, currency,
      quantityKm: decimalText(c.quantityKm), incurredOn: c.incurredOn, employeeReason: c.description?.slice(0, 2000) ?? null,
      fields: claimAnswers(f),
      receipts: c.attachments.slice(0, 50).map((a) => ({ id: a.id, fileName: a.fileName.slice(0, 300), sizeBytes: a.sizeBytes })),
      expected: { status: 'pending' },
    } };
  }
  if (kind === 'leaveCancellation') {
    const [c] = await listPendingLeaveCancellations(ctx, undefined, locale, id);
    if (!c) return gone();
    return { outcome: 'found', task: {
      kind, id: c.id, subject: { name: c.employee, code: c.employeeCode ?? null }, createdAt: iso(c.createdAt),
      // decideLeaveCancellation records no rejection reason (the web asks none); the app does not invent one.
      reasonRequiredToReject: false,
      leaveType: c.leaveType, originalStart: c.originalStart, originalEnd: c.originalEnd, cancelDates: c.cancelDates,
      requestedDays: num(c.requestedDays), employeeReason: c.reason ?? null, expected: { stepIndex: c.currentStepIndex ?? null },
    } };
  }
  const [a] = await listAttendanceCorrections(ctx, { status: 'pending', requestId: id });
  if (!a) return gone();
  if (!a.canDecide) return refused('not_assigned');
  const overtime = isOvertimeCorrection(a);
  // The decider applies an HR amendment in place of the employee's proposal; show what would be applied.
  const amended = a.adminAmendment ?? null;
  const dayType = overtime ? (await dayTypesForPairs(ctx, [{ employmentId: a.employmentId, date: a.attendanceDate }])).get(`${a.employmentId}|${a.attendanceDate}`) ?? null : null;
  return { outcome: 'found', task: {
    kind, id: a.id, subject: { name: a.employee, code: a.employeeCode ?? null }, createdAt: iso(a.createdAt), reasonRequiredToReject: true,
    application: overtime ? 'overtime' : 'correction', date: a.attendanceDate,
    proposedCheckIn: hhmm(amended ? amended.checkIn : a.proposedCheckIn), proposedCheckOut: hhmm(amended ? amended.checkOut : a.proposedCheckOut),
    plannedStart: hhmm(a.plannedStartTime), plannedEnd: hhmm(a.plannedEndTime), requestedOtMinutes: a.requestedOtMinutes ?? null, dayType,
    employeeReason: a.reason ?? null, hasAttachment: !!a.hasAttachment,
    expected: { stageIndex: a.workflow?.currentStage ?? null, participantSlot: a.workflow?.currentParticipantSlot ?? null },
    // The web approver's "Original clock times", under the same condition the web prints it (app/(app)/approvals/page.tsx).
    original: a.proposedCheckIn || a.clockChanges ? originalOf(a.originalClockSnapshot) : null,
    proposedPunches: a.clockChanges ? a.clockChanges.entries.slice(0, 100).flatMap((e) => { const at = hhmm(e.punchAt); return at ? [{ at, direction: e.direction }] : []; }) : null,
  } };
}

// ── Document ───────────────────────────────────────────────────────────────────────────────────────────────

export type TaskDocument = { outcome: 'file'; contentType: MobileBinaryType; fileName: string; bytes: Uint8Array };
/** The leave request's supporting document for an admitted approver: PDF, JPEG or PNG with a matching signature. */
export async function taskDocumentV2(ctx: SessionContext, id: string): Promise<TaskDocument | TaskDocumentRefusal> {
  const refusal = await admission(ctx, 'leave', id);
  if (refusal) return refused(refusal);
  const [r] = await listLeaveRequests(ctx, undefined, 1, { status: 'pending', requestId: id });
  if (!r) return refused(await classify(ctx, 'leave', id));
  if (!r.hasDocument) return refused('no_document');
  const file = await leave.getLeaveAttachment(ctx, r.id);
  if (!file) return refused('no_document');
  const type = file.mimeType.toLowerCase(), bytes = new Uint8Array(file.content);
  // A type the owner accepted but the phone is not sent, or bytes that are not what the label says: the web.
  if (!isMobileBinaryType(type, MOBILE_ATTACHMENT_TYPES) || !hasMobileBinarySignature(type, bytes)) return refused('unsupported_document');
  return { outcome: 'file', contentType: type, fileName: file.fileName, bytes };
}

/**
 * D12 — one receipt of a pending claim the caller is CURRENTLY assigned (the detail's admission), through
 * getClaimAttachment: PDF, JPEG or PNG whose bytes match the label, else `unsupported_document`. A receipt id that is
 * not this claim's is `no_document`.
 */
export async function taskClaimReceiptV2(ctx: SessionContext, id: string, attachmentId: string): Promise<TaskDocument | TaskDocumentRefusal> {
  const refusal = await admission(ctx, 'claim', id);
  if (refusal) return refused(refusal);
  const [c] = await claims.listPendingClaims(ctx, { requestId: id });
  if (!c) return refused(await classify(ctx, 'claim', id));
  if (!c.attachments.some((a) => a.id === attachmentId)) return refused('no_document');
  return receiptFile(ctx, attachmentId, refused('no_document'));
}

// ── Decision ───────────────────────────────────────────────────────────────────────────────────────────────

/** Leave-pack refusal classes, by the export-name allowlist core/mobile-leave-history.ts uses. */
const isLeaveDomainError = (e: unknown) => Object.entries(leave).some(([n, v]) =>
  /^(Leave|ReplacementCredit|InsufficientLeave|NegativeLeave|HourlyLeave|MissingReject).*Error$/.test(n) && typeof v === 'function' && e instanceof (v as typeof Error));
const LABELS = ['leave request', 'leave cancellation', 'claim'];
/** decideClaim's own sentences for a claim that is no longer pending, or not readable (core/claims.ts). */
const CLAIM_NOT_PENDING = 'Only a pending claim can be decided';
const CLAIM_NOT_FOUND = 'Claim not found';
const ALREADY = /^(leave request|cancellation request|correction request) is already \w+$/;
/** A leave chain step's per-kind authority refusal (core/leave.ts assertCanDecideAsApprover). */
const STEP_AUTHORITY = /^Only .+ can decide this (leave request|leave cancellation)$/;

/**
 * A thrown refusal as the app reads it; anything else is rethrown (a logged 500). The canonical sentence travels
 * only for an allowlisted refusal class — the leave pack's own, the attendance workflow's, the payroll lock, or a
 * decider's plain domain `Error` (never a database error: publicErrorMessage would reduce it to a reference anyway).
 */
export function decisionRefusal(e: unknown): TaskDecisionRefusal {
  if (e instanceof TaskRefused) return refused(e.code);
  if (e instanceof MobileCommandOwnerRequired) return refused('employment_required');
  if (e instanceof leave.LeaveStaleStepError || (e instanceof AttendanceWorkflowError && e.code === 'stale')) return refused('stale_step');
  if (e instanceof leave.MissingRejectReasonError || e instanceof MissingAttendanceRejectReasonError) return refused('reason_required');
  if (e instanceof Error && e.constructor === Error && ALREADY.test(e.message)) return refused('already_decided');
  if (LABELS.some((label) => isApprovalDecisionRefusal(e, label))) return refused((e as Error).message.startsWith('You cannot decide your own') ? 'self_approval' : 'not_assigned');
  if (e instanceof Error && e.constructor === Error && STEP_AUTHORITY.test(e.message)) return refused('not_assigned');
  if (e instanceof AttendanceWorkflowError && e.code === 'notApprover') return refused(/your own/.test(e.message) ? 'self_approval' : 'not_assigned');
  // AttendanceLevelError's message is a problem code, not a sentence: no message.
  if (e instanceof AttendanceLevelError) return refused('decision_refused');
  // D12: decideClaim's refusals. A limit the approval would breach carries the kernel's own sentence.
  if (e instanceof claims.ClaimError) {
    if (e.message === CLAIM_NOT_PENDING) return refused('already_decided');
    if (e.message === CLAIM_NOT_FOUND) return refused('not_assigned');
    return { ...refused('decision_refused'), message: publicErrorMessage(e).slice(0, 4000) };
  }
  const sentence = e instanceof AttendanceWorkflowError || e instanceof LeavePayrollBusyError || e instanceof LeavePayrollClosedError || isLeaveDomainError(e)
    || (e instanceof Error && e.constructor === Error && !isDatabaseError(e));
  if (sentence) return { ...refused('decision_refused'), message: publicErrorMessage(e).slice(0, 4000) };
  throw e;
}
const statusOf = (s: string): 'approved' | 'rejected' | 'pending_next_step' => (s === 'approved' || s === 'rejected' ? s : 'pending_next_step');

/**
 * Decide one admitted task through its canonical decider, inside the mobile command receipt. The route has already
 * checked that `expected` has this kind's shape and that `dates` appears only on a leave approval.
 */
export async function decideTaskV2(ctx: SessionContext, kind: NativeTaskKind, id: string, c: TaskDecisionCommand): Promise<TaskDecisionResult> {
  const me = await myEmployment(ctx);
  if (!me) return refused('employment_required');
  const reason = c.reason?.trim() || undefined;
  const approve = c.decision === 'approve';
  const dates = c.dates ? [...new Set(c.dates)].sort() : undefined;
  const expected = c.expected as { stepIndex?: number | null; stageIndex?: number | null; participantSlot?: string | null };
  // Admission is read BEFORE the receipt but consulted INSIDE its run: a replay of a committed decision returns the
  // recorded answer even though the item is no longer this caller's task.
  const refusal = await admission(ctx, kind, id);
  try {
    return await withMobileCommandReceipt(ctx, {
      kind: 'task.decision', requestId: c.requestId, actorEmploymentId: me.employmentId, response: TaskDecisionResult,
      intent: { kind, id, decision: c.decision, reason: reason ?? null, dates: dates ?? null, expected: c.expected },
    }, async (tx) => {
      if (refusal) throw new TaskRefused(refusal);
      const row = await rawRowTx(tx, kind, id);
      if (!row) throw new TaskRefused('not_assigned');
      if (await isOwnEmploymentTx(tx, ctx, row.employmentId)) throw new TaskRefused('self_approval');
      const decision = approve ? 'approved' as const : 'rejected' as const;
      if (kind === 'leave') {
        const stored = await tx.select({ date: leaveRequestDate.leaveDate, status: leaveRequestDate.status }).from(leaveRequestDate).where(eq(leaveRequestDate.leaveRequestId, id));
        if (!stored.length) {
          if (dates) throw new TaskRefused('stale_step'); // the app's view had dates; the request has none
          const out = await leave.decideLeave(ctx, { leaveRequestId: id, decision, rejectReason: reason, deciderEmploymentId: me.employmentId, expectedStepIndex: expected.stepIndex ?? null }, tx);
          return { outcome: 'accepted' as const, status: statusOf(out.status) };
        }
        // Per-date (ADR-0068): every still-pending date is decided in one submit, as the web's decision table does.
        const pending = stored.filter((d) => d.status === 'pending').map((d) => d.date).sort();
        const approved = new Set(approve ? dates ?? pending : []);
        if (!pending.length || [...approved].some((d) => !pending.includes(d))) throw new TaskRefused('stale_step');
        const out = await leave.decideLeaveDates(ctx, {
          leaveRequestId: id, deciderEmploymentId: me.employmentId, expectedStepIndex: expected.stepIndex ?? null,
          decisions: pending.map((d) => approved.has(d) ? { leaveDate: d, decision: 'approved' as const } : { leaveDate: d, decision: 'rejected' as const, rejectReason: reason }),
        }, tx);
        return { outcome: 'accepted' as const, status: statusOf(out.status) };
      }
      if (kind === 'leaveCancellation') {
        const out = await leave.decideLeaveCancellation(ctx, { cancellationRequestId: id, decision, deciderEmploymentId: me.employmentId, expectedStepIndex: expected.stepIndex ?? null }, tx);
        return { outcome: 'accepted' as const, status: statusOf(out.status) };
      }
      if (kind === 'claim') {
        // One step, no chain: the only state the approver can have seen is `pending` (the expected state); a reason is
        // required to reject (D12) and recorded on the rejection event; decideClaim re-checks the limits on approval.
        if (row.status !== 'pending') throw new TaskRefused('already_decided');
        if (!approve && !reason) throw new TaskRefused('reason_required');
        await claims.decideClaim(ctx, {
          claimRequestId: id, decision: approve ? 'approve' : 'reject', deciderEmploymentId: me.employmentId, ...(approve ? {} : { rejectReason: reason }),
        }, tx);
        return { outcome: 'accepted' as const, status: approve ? 'approved' as const : 'rejected' as const };
      }
      const out = await decideAttendanceCorrection(ctx, {
        correctionId: id, decision, deciderEmploymentId: me.employmentId,
        ...(approve ? (reason ? { remarks: reason } : {}) : { rejectReason: reason ?? '' }),
        expectedStageIndex: expected.stageIndex ?? undefined, expectedParticipantSlot: expected.participantSlot ?? undefined,
      }, tx);
      return { outcome: 'accepted' as const, status: statusOf(out.status) };
    });
  } catch (e) {
    return decisionRefusal(e);
  }
}
