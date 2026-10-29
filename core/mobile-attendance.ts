/**
 * M12 (D13) — the employee's own attendance in the app. COMPOSITION ONLY: every fact comes from the owner the web's
 * own personal screens read, and every command is the service the web's action calls. Nothing here decides an
 * attendance or leave rule.
 *
 *   records      attendanceForEmploymentRange + attendancePunchesForRange, flagOf / personalAttendanceStatus
 *                (app/attendance/my-roster/record-list.tsx and app/attendance/my-records/[date])
 *   roster       myRosterWindow (core/roster.ts — My Roster's own read); crossing midnight by shiftCrossesMidnight,
 *                the rule a shift is saved with
 *   day          the records read for one date + myAttendanceCorrections({date}); the correction form is offered by
 *                the day screen's own predicate (not future, nothing pending)
 *   history      myAttendanceCorrectionsPage (the request-status list's read, keyset-paged) + myAttendanceCorrectionCounts;
 *                status words and the withdraw predicate from app/attendance/request-ui.tsx / request-status canCancel;
 *                the routing is the workflow snapshot recorded with the request (attendanceWorkflowsForTx)
 *   correction   requestAttendanceCorrection, in the mobile command receipt's transaction (its existing `existingTx`)
 *   withdraw     cancelOwnAttendanceCorrection, in the receipt's transaction (D13 seam)
 *   OT plan      app/attendance/plan-ot/apply + myRequestOvertime (app/me/actions.ts): the minutes derived from the
 *                planned window by plannedOvertimeMinutes, then requestAttendanceCorrection with requestedOtMinutes,
 *                the window, the reason and the remark, in the receipt's transaction. The page refuses only a login
 *                with no employment, and the attendance layout only a tenant without the module; nothing else.
 *   Leave Credit replacementRequestAvailability + leaveCreditOfferForEmployment + pickReplacementLeaveType (My Leave),
 *                extendedHoursDayForEmployment + leaveCreditClaimReview (the Leave Credit table's per-date reads),
 *                submitLeaveCreditRequest in the receipt's transaction (D13 seam) — app/leave/credit/actions.ts
 *
 * SCOPE. `employmentId` is the caller's OWN selected employment, already verified by the route
 * (lib/mobile-api/request.ts mobileEmployment). Every read narrows to it, so a row RLS would show a manager (a
 * subordinate's day or request) is simply absent here: `not_found`, never a subordinate's data. The services
 * re-assert "only the employee" themselves where they write.
 *
 * MODULE GATE. The attendance services gate themselves (withAttendanceTenant), but a service handed the receipt's
 * transaction does not open its own, so the gate is asked HERE first; Leave Credit asks the `toil` add-on, as its
 * submit does.
 *
 * A REFUSAL ROLLS BACK. A service that refuses throws, the throw aborts the receipt's transaction (it may have
 * locked or written before deciding), so a refusal is mapped AFTER withMobileCommandReceipt, records no receipt,
 * and a retry re-evaluates it. Only an accepted command is recorded and replayed.
 *
 * TIME. Dates are calendar dates and clock times wall times in HR_LOCAL_TZ (lib/hr-date.ts), the kernel's one
 * business-day zone; it is sent with every answer so the app names it rather than assuming the device's.
 *
 * Kept free of 'server-only' (mobile-command-receipt.ts says why).
 */
import type { z } from 'zod';
import type { SessionContext } from '../db/client';
import { isModuleEnabled, ModuleNotEnabledError } from './entitlements';
import { listLeaveTypes } from './read';
import { pickReplacementLeaveType } from './ess-view';
import { myRosterWindow, shiftCrossesMidnight } from './roster';
import { ClaimOverlapError } from './credit-ot-overlap';
import { withMobileCommandReceipt } from './mobile-command-receipt';
import * as att from '../packs/attendance/service';
import * as leave from '../packs/leave/service';
import { attendanceApplicationType, AttendanceWorkflowError } from '../lib/attendance-workflow';
import { AttendanceLevelError } from '../lib/attendance-workflow-v3';
import { claimCrossesMidnight } from '../lib/extended-hours';
import { plannedOvertimeMinutes } from '../lib/overtime-duration';
import { isDatabaseError } from '../lib/db-error';
import { HR_LOCAL_TZ, todayInKualaLumpur } from '../lib/hr-date';
import { publicErrorMessage } from '../lib/public-error';
import { encodeCursor } from '../lib/mobile-api/v2/common';
import {
  ATTENDANCE_APPLICATIONS_CURSOR, AttendanceCorrectionResult, AttendanceWithdrawResult, OvertimePlanResult, ReplacementLeaveResult,
  type OvertimePlanCommand, type OvertimePlanOfferV2,
  type AttendanceApplicationDetailV2, type AttendanceApplicationKind, type AttendanceApplicationLevelV2,
  type AttendanceApplicationResult, type AttendanceApplicationsPageV2, type AttendanceApplicationStatus,
  type AttendanceApplicationSummaryV2, type AttendanceCommandRefusal, type AttendanceCommandRefusalCode,
  type AttendanceCorrectionCommand, type AttendanceDayResult, type AttendanceDayV2, type AttendanceRecordsV2,
  type AttendanceRosterV2, type ReplacementLeaveCommand, type ReplacementLeaveDayResult, type ReplacementLeaveDayV2,
  type ReplacementLeaveOfferV2, type ReplacementLeaveRefusal, type ReplacementLeaveRefusalCode,
} from '../lib/mobile-api/v2/attendance';

type RangeRow = Awaited<ReturnType<typeof att.attendanceForEmploymentRange>>[number];
type PunchMap = Awaited<ReturnType<typeof att.attendancePunchesForRange>>;
type RequestRow = att.MyAttendanceRequestRow;
type Workflow = NonNullable<RequestRow['workflow']>;

export const attendanceEnabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'attendance');
const leaveCreditEnabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'toil');
const NOT_FOUND = { outcome: 'refused', code: 'not_found' } as const;
const MODULE_OFF = { outcome: 'refused', code: 'module_off' } as const;
const ZERO_COUNTS = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };

/** `HH:MM[:SS]` → `HH:MM`; null stays null. Formatting, not arithmetic. */
const hhmm = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null);
const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : (d instanceof Date ? d : new Date(String(d))).toISOString());
const crosses = (start: string | null, end: string | null) => !!start && !!end && shiftCrossesMidnight(start, end);

// ── Records, roster, one day ───────────────────────────────────────────────────────────────────────────────

/** One day as the web's personal list and day screen print it, in four separate parts (lib/mobile-api/v2/attendance.ts). */
export function attendanceDayOf(r: RangeRow, punches: PunchMap, today: string): AttendanceDayV2 {
  const start = hhmm(r.shiftStart), end = hhmm(r.shiftEnd);
  return {
    date: r.date,
    schedule: {
      shiftCode: r.shiftCode, start, end, crossesMidnight: crosses(start, end), scheduledMinutes: r.scheduledMinutes,
      rosteredRest: r.isRosterRest, dayType: r.dayType, context: r.context,
    },
    // Keyed by attendance id, exactly as the web's day screen reads it — no second shape for one fact.
    punches: (r.attendanceId ? punches.get(r.attendanceId) ?? [] : []).map((p) => ({ at: p.punchAt.slice(0, 5), direction: p.direction })),
    outcome: {
      recorded: r.attendanceId != null, checkIn: hhmm(r.checkInAt), checkOut: hhmm(r.checkOutAt),
      workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes, earlyOutMinutes: r.earlyOutMinutes,
      status: att.personalAttendanceStatus(r, today),
    },
    exception: att.flagOf(r),
  };
}

/** The caller's own days over [from, to] (≤ 31, checked by the route), ascending. */
export async function ownAttendanceRecords(ctx: SessionContext, employmentId: string | null, w: { from: string; to: string }): Promise<AttendanceRecordsV2> {
  const today = todayInKualaLumpur();
  const base = { timeZone: HR_LOCAL_TZ, today, from: w.from, to: w.to };
  if (!attendanceEnabled(ctx)) return { enabled: false, employmentId: null, ...base, days: [] };
  if (!employmentId) return { enabled: true, employmentId: null, ...base, days: [] };
  const [rows, punches] = await Promise.all([
    att.attendanceForEmploymentRange(ctx, employmentId, w.from, w.to),
    att.attendancePunchesForRange(ctx, employmentId, w.from, w.to),
  ]);
  return { enabled: true, employmentId, ...base, days: rows.map((r) => attendanceDayOf(r, punches, today)) };
}

/** The caller's own roster over [from, to] (≤ 31), as My Roster resolves it. */
export async function ownAttendanceRoster(ctx: SessionContext, employmentId: string | null, w: { from: string; to: string }): Promise<AttendanceRosterV2> {
  const empty = { timeZone: HR_LOCAL_TZ, from: w.from, to: w.to, days: [], totals: { workDays: 0, rosteredDays: 0, restDays: 0, plannedMinutes: 0 } };
  if (!attendanceEnabled(ctx)) return { enabled: false, employmentId: null, ...empty };
  if (!employmentId) return { enabled: true, employmentId: null, ...empty };
  const view = await myRosterWindow(ctx, { from: w.from, to: w.to, employmentId });
  if (!view) return { enabled: true, employmentId: null, ...empty };
  return {
    enabled: true, employmentId: view.employmentId, timeZone: HR_LOCAL_TZ, from: w.from, to: w.to,
    days: view.days.map((d) => {
      const start = hhmm(d.shift?.startTime), end = hhmm(d.shift?.endTime);
      return {
        date: d.date, kind: d.cell.kind,
        shift: d.shift ? { code: d.shift.code, name: d.shift.name, start, end, crossesMidnight: crosses(start, end), workingMinutes: d.shift.workingMinutes } : null,
        plannedMinutes: d.plannedMinutes, note: d.note,
      };
    }),
    totals: { workDays: view.workDays, rosteredDays: view.rosteredDays, restDays: view.restDays, plannedMinutes: view.plannedMinutes },
  };
}

/** One of the caller's own days, its own applications for the date, and whether the day screen offers a correction. */
export async function ownAttendanceDay(ctx: SessionContext, employmentId: string | null, date: string): Promise<AttendanceDayResult> {
  if (!attendanceEnabled(ctx)) return MODULE_OFF;
  if (!employmentId) return NOT_FOUND;
  const [rows, punches, requests] = await Promise.all([
    att.attendanceForEmploymentRange(ctx, employmentId, date, date),
    att.attendancePunchesForRange(ctx, employmentId, date, date),
    att.myAttendanceCorrections(ctx, employmentId, { date, limit: 100 }),
  ]);
  const row = rows[0];
  if (!row) return NOT_FOUND;
  const today = todayInKualaLumpur();
  // app/attendance/my-records/[date]/page.tsx: the form is disabled while a request for the date waits, and for a future date.
  const pending = requests.some((r) => r.status === 'pending');
  const future = date > today;
  return {
    outcome: 'found', timeZone: HR_LOCAL_TZ, today,
    day: attendanceDayOf(row, punches, today),
    applications: requests.map(applicationSummaryOf),
    correction: { offered: !pending && !future, blockedBy: future ? 'future' : pending ? 'pending' : null },
  };
}

// ── Own application history ────────────────────────────────────────────────────────────────────────────────

/** lib/attendance-workflow.ts attendanceApplicationType; HR's clock-data proposals named on their own. */
function applicationKindOf(r: RequestRow): AttendanceApplicationKind {
  if (r.clockChanges) return 'clock_data';
  return attendanceApplicationType(r) === 'self_overtime' ? 'overtime' : 'correction';
}

/** app/attendance/request-ui.tsx statusLabel: a cancelled row reads Withdrawn unless its provenance says HR cancelled it. */
function displayOf(r: RequestRow): AttendanceApplicationSummaryV2['displayStatus'] {
  if (r.status === 'cancelled') return r.cancellationKind === 'cancelled' ? 'cancelled' : 'withdrawn';
  return r.status as 'pending' | 'approved' | 'rejected';
}

export function applicationSummaryOf(r: RequestRow): AttendanceApplicationSummaryV2 {
  return {
    id: r.id, date: r.attendanceDate, application: applicationKindOf(r), requestKind: r.requestKind ?? null,
    status: r.status as AttendanceApplicationStatus, displayStatus: displayOf(r),
    asked: {
      checkIn: hhmm(r.proposedCheckIn), checkOut: hhmm(r.proposedCheckOut), requestedOtMinutes: r.requestedOtMinutes,
      plannedStart: hhmm(r.plannedStartTime), plannedEnd: hhmm(r.plannedEndTime),
      clockEntries: r.clockChanges ? r.clockChanges.entries.length : null,
    },
    // request-status/page.tsx submittedOn: the Malaysian calendar day the request was filed.
    submittedOn: todayInKualaLumpur(r.createdAt),
  };
}

/**
 * The routing RECORDED with the application, level by level — the structure components/attendance-workflow-progress.tsx
 * prints on the web: a decided level names who decided, how and when; a pending application waits at its current level.
 */
function routingOf(flow: Workflow, status: string): AttendanceApplicationDetailV2['routing'] {
  const levels = flow.stages.map((original, index): AttendanceApplicationLevelV2 => {
    const stage = flow.effectiveStages?.[index] ?? original;
    const decision = flow.decisions.find((d) => d.stageIndex === index);
    const approvers: AttendanceApplicationLevelV2['approvers'] = stage.approvers.map((a) => (a.kind === 'hr_admin' ? { kind: 'hr' as const, name: '' } : { kind: 'person' as const, name: a.name }));
    if (stage.hrAlternative && !approvers.some((a) => a.kind === 'hr')) approvers.push({ kind: 'hr', name: '' });
    return {
      level: index + 1, name: stage.name ?? '',
      status: decision ? decision.decision : status === 'pending' ? (index === flow.currentStage ? 'waiting' : 'not_reached') : 'not_required',
      approvers: approvers.slice(0, 20),
      decision: decision ? { actorName: decision.actualActorName, actingMode: decision.actingMode, decidedAt: iso(decision.decidedAt)!, remarks: decision.remarks ?? null } : null,
    };
  });
  return { templateName: flow.templateName, templateVersion: flow.templateVersion, currentLevel: status === 'pending' ? flow.currentStage + 1 : null, levels: levels.slice(0, 20) };
}

function applicationDetailOf(r: RequestRow): AttendanceApplicationDetailV2 {
  const snapshot = r.originalClockSnapshot;
  const kind = applicationKindOf(r);
  return {
    ...applicationSummaryOf(r),
    reason: r.reason ?? null, remark: r.remark ?? null,
    original: snapshot ? { checkIn: hhmm(snapshot.originalCheckIn), checkOut: hhmm(snapshot.originalCheckOut), capturedAt: snapshot.capturedAt ?? null } : null,
    rejectReason: r.status === 'rejected' ? r.rejectReason ?? null : null,
    decidedAt: iso(r.decidedAt),
    hasAttachment: r.hasAttachment,
    routing: r.workflow ? routingOf(r.workflow, r.status) : null,
    // request-status/page.tsx canCancel: an overtime plan is withdrawn on the web (Self Overtime), anything else only while pending.
    actions: { withdraw: kind !== 'overtime' && r.status === 'pending' },
  };
}

/** One page of the caller's own applications on one employment, in the kernel's own order. */
export async function ownAttendanceApplicationsPage(
  ctx: SessionContext,
  employmentId: string | null,
  q: { status?: AttendanceApplicationStatus; limit: number; cursor: readonly [string, string, string] | null },
): Promise<AttendanceApplicationsPageV2> {
  const empty = { items: [], nextCursor: null, timeZone: HR_LOCAL_TZ, counts: ZERO_COUNTS };
  if (!attendanceEnabled(ctx)) return { enabled: false, employmentId: null, ...empty };
  if (!employmentId) return { enabled: true, employmentId: null, ...empty };
  const [rows, counts] = await Promise.all([
    att.myAttendanceCorrectionsPage(ctx, employmentId, {
      limit: q.limit + 1, status: q.status, before: q.cursor ? { date: q.cursor[0], at: q.cursor[1], id: q.cursor[2] } : null,
    }),
    att.myAttendanceCorrectionCounts(ctx, employmentId),
  ]);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    enabled: true, employmentId, timeZone: HR_LOCAL_TZ, counts,
    items: page.map(applicationSummaryOf),
    nextCursor: rows.length > q.limit && last ? encodeCursor(ATTENDANCE_APPLICATIONS_CURSOR, [last.attendanceDate, last.cursorAt, last.id]) : null,
  };
}

/** The row, only when it belongs to `employmentId` (the caller's own, verified upstream). */
async function ownRequest(ctx: SessionContext, employmentId: string, id: string): Promise<RequestRow | null> {
  const [row] = await att.myAttendanceCorrectionsPage(ctx, employmentId, { limit: 1, ids: [id] });
  return row ?? null;
}

export async function ownAttendanceApplication(ctx: SessionContext, employmentId: string | null, id: string): Promise<AttendanceApplicationResult> {
  if (!attendanceEnabled(ctx)) return MODULE_OFF;
  if (!employmentId) return NOT_FOUND;
  const r = await ownRequest(ctx, employmentId, id.toLowerCase());
  return r ? { outcome: 'found', timeZone: HR_LOCAL_TZ, application: applicationDetailOf(r) } : NOT_FOUND;
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────

/** A kernel validation refusal: a PLAIN Error the service threw with a sentence for the reader (never a driver error). */
const plainRefusal = (e: unknown) => e instanceof Error && e.constructor === Error && !isDatabaseError(e);

/** An attendance service refusal as its v2 code (+ the service's own sentence); anything else is rethrown (a 500). */
export function attendanceCommandRefusal(e: unknown): AttendanceCommandRefusal {
  const refuse = (code: AttendanceCommandRefusalCode): AttendanceCommandRefusal => ({ outcome: 'refused', code, message: publicErrorMessage(e).slice(0, 4000) });
  if (e instanceof ModuleNotEnabledError) return refuse('module_off');
  if (e instanceof att.AttendanceWithdrawRefusedError) return refuse('not_withdrawable');
  if (e instanceof att.AttendanceCorrectionFutureDateError) return refuse('future');
  if (e instanceof att.AttendanceCorrectionPendingError) return refuse('pending_exists');
  if (e instanceof att.AttendancePayrollClosedError) return refuse('payroll_closed');
  if (e instanceof AttendanceLevelError || e instanceof AttendanceWorkflowError) return refuse('workflow_unavailable');
  // The overtime plan's two dated refusals (an approved plan still waiting for the day; overtime already counted on
  // it). Typed for the web's localized sentence; here the kernel's own sentence travels as the message.
  if (e instanceof att.OvertimePlanAlreadyApprovedError || e instanceof att.OvertimeAlreadyCountedError) return refuse('invalid');
  if (e instanceof att.ClockDataChangedError || plainRefusal(e)) return refuse('invalid');
  throw e;
}

async function command<S extends z.ZodType, R>(run: () => Promise<z.output<S>>, refusal: (e: unknown) => R): Promise<z.output<S> | R> {
  try { return await run(); } catch (e) { return refusal(e); }
}

/**
 * A missed-punch / correction request for one of the caller's own days (requestAttendanceCorrection, as the web day
 * screen files it: proposed times, the reason, no request kind — the kernel files it as `other`). Replays its first
 * accepted answer under the same requestId.
 */
export async function requestOwnAttendanceCorrectionV2(ctx: SessionContext, employmentId: string, p: AttendanceCorrectionCommand): Promise<z.output<typeof AttendanceCorrectionResult>> {
  if (!attendanceEnabled(ctx)) return MODULE_OFF;
  const checkIn = p.checkIn ?? null, checkOut = p.checkOut ?? null, reason = p.reason.trim(), remark = p.remark?.trim() || null;
  return command<typeof AttendanceCorrectionResult, AttendanceCommandRefusal>(() => withMobileCommandReceipt(ctx, {
    kind: 'attendance.correction', requestId: p.requestId, intent: { date: p.date, checkIn, checkOut, reason, remark },
    actorEmploymentId: employmentId, response: AttendanceCorrectionResult,
  }, async (tx) => {
    const out = await att.requestAttendanceCorrection(ctx, { employmentId, date: p.date, checkIn, checkOut, reason, remark }, tx);
    return { outcome: 'submitted' as const, id: out.correctionId, date: p.date };
  }), attendanceCommandRefusal);
}

/** Withdraw the caller's own PENDING application (cancelOwnAttendanceCorrection). Replays its first accepted answer. */
export async function withdrawOwnAttendanceApplicationV2(ctx: SessionContext, employmentId: string, applicationId: string, requestId: string): Promise<z.output<typeof AttendanceWithdrawResult>> {
  if (!attendanceEnabled(ctx)) return MODULE_OFF;
  const id = applicationId.toLowerCase();
  if (!(await ownRequest(ctx, employmentId, id))) return NOT_FOUND;
  return command<typeof AttendanceWithdrawResult, AttendanceCommandRefusal>(() => withMobileCommandReceipt(ctx, {
    kind: 'attendance.withdraw', requestId, intent: { correctionId: id }, actorEmploymentId: employmentId, response: AttendanceWithdrawResult,
  }, async (tx) => {
    await att.cancelOwnAttendanceCorrection(ctx, { correctionId: id }, tx);
    return { outcome: 'withdrawn' as const, id };
  }), attendanceCommandRefusal);
}

// ── Self overtime plan (Apply OT Plan) ─────────────────────────────────────────────────────────────────────

/** Whether the web's Apply OT Plan page would offer its form: the module (attendance layout) and an own employment. */
export async function overtimePlanOfferV2(ctx: SessionContext, employmentId: string | null): Promise<OvertimePlanOfferV2> {
  const base = { timeZone: HR_LOCAL_TZ, today: todayInKualaLumpur() };
  if (!attendanceEnabled(ctx)) return { enabled: false, employmentId: null, allowed: false, reason: 'module_off', ...base };
  if (!employmentId) return { enabled: true, employmentId: null, allowed: false, reason: 'no_employment', ...base };
  return { enabled: true, employmentId, allowed: true, reason: null, ...base };
}

/**
 * File an overtime plan for one of the caller's own dates, as myRequestOvertime does: the minutes are the planned
 * window's (plannedOvertimeMinutes — an inverted or equal window is refused there, before anything is written), then
 * requestAttendanceCorrection with requestedOtMinutes, the window, the reason and the remark. The kernel files it as
 * `self_overtime`, validates it and routes it. Replays its first accepted answer under the same requestId.
 */
export async function requestOwnOvertimePlanV2(ctx: SessionContext, employmentId: string, p: OvertimePlanCommand): Promise<z.output<typeof OvertimePlanResult>> {
  if (!attendanceEnabled(ctx)) return MODULE_OFF;
  const minutes = plannedOvertimeMinutes(p.plannedStart, p.plannedEnd);
  // myRequestOvertime's own sentence for the same refusal.
  if (minutes == null) return { outcome: 'refused', code: 'invalid', message: 'Enter different valid start and end times.' };
  const reason = p.reason.trim(), remark = p.remark?.trim() || null;
  return command<typeof OvertimePlanResult, AttendanceCommandRefusal>(() => withMobileCommandReceipt(ctx, {
    kind: 'attendance.overtime-plan', requestId: p.requestId,
    intent: { date: p.date, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd, reason, remark },
    actorEmploymentId: employmentId, response: OvertimePlanResult,
  }, async (tx) => {
    const out = await att.requestAttendanceCorrection(ctx, {
      employmentId, date: p.date, requestedOtMinutes: minutes, reason, remark, plannedStartTime: p.plannedStart, plannedEndTime: p.plannedEnd,
    }, tx);
    return { outcome: 'submitted' as const, id: out.correctionId, date: p.date, minutes };
  }), attendanceCommandRefusal);
}

// ── Replacement leave (Leave Credit) ───────────────────────────────────────────────────────────────────────

/** My Leave's own three reads: may this employee ask, which type a credit lands on, and the company's ladder. */
export async function replacementLeaveOfferV2(ctx: SessionContext, employmentId: string | null, locale: string): Promise<ReplacementLeaveOfferV2> {
  const today = todayInKualaLumpur();
  const base = { employmentId, timeZone: HR_LOCAL_TZ, today, requiresFirstScheduleConsent: false, leaveType: null, tiers: null, ordinaryDayAllowed: false };
  if (!employmentId) return { ...base, allowed: false, reason: 'no_employment' };
  const availability = await leave.replacementRequestAvailability(ctx, employmentId, today);
  if (!availability.allowed) return { ...base, allowed: false, reason: availability.reason ?? 'not_eligible' };
  const [types, offer] = await Promise.all([listLeaveTypes(ctx, { locale, includeArchived: false }), leave.leaveCreditOfferForEmployment(ctx, employmentId)]);
  const type = pickReplacementLeaveType(types);
  if (!type) return { ...base, allowed: false, reason: 'no_leave_type' };
  return {
    ...base, allowed: true, reason: null, requiresFirstScheduleConsent: availability.requiresFirstScheduleConsent === true,
    leaveType: { id: type.id, name: type.name },
    tiers: offer ? { halfDayMinutes: offer.tiers.extendedHalfDayMinutes, fullDayMinutes: offer.tiers.extendedFullDayMinutes } : null,
    ordinaryDayAllowed: offer?.ordinaryDayAllowed ?? false,
  };
}

type ClaimReview = Awaited<ReturnType<typeof leave.leaveCreditClaimReview>>;
function reviewOf(r: ClaimReview, start: string, end: string): NonNullable<ReplacementLeaveDayV2['review']> {
  const midnight = claimCrossesMidnight(start, end);
  if (r.basis === 'legacy') return { state: 'legacy', reason: null, eligibleMinutes: null, creditDays: null, crossesMidnight: midnight };
  if (r.basis === 'unavailable') return { state: 'unavailable', reason: r.reason, eligibleMinutes: null, creditDays: null, crossesMidnight: midnight };
  return { state: r.status, reason: r.reason, eligibleMinutes: r.eligibleMinutes, creditDays: r.creditDays, crossesMidnight: midnight };
}

/** One worked date's facts (the Leave Credit table's per-date read) and, with a window, the kernel's own review of it. */
export async function replacementLeaveDayV2(ctx: SessionContext, employmentId: string | null, q: { date: string; start?: string; end?: string }): Promise<ReplacementLeaveDayResult> {
  if (!employmentId) return NOT_FOUND;
  if (!leaveCreditEnabled(ctx)) return { outcome: 'refused', code: 'unavailable' };
  let day: Awaited<ReturnType<typeof leave.extendedHoursDayForEmployment>>;
  try { day = await leave.extendedHoursDayForEmployment(ctx, employmentId, q.date); }
  catch (e) { if (leave.leaveCreditDayFactsUnavailable(e)) return { outcome: 'refused', code: 'unavailable' }; throw e; }
  const review = q.start && q.end ? reviewOf(await leave.leaveCreditClaimReview(ctx, { employmentId, workedDate: q.date, claimStart: q.start, claimEnd: q.end }), q.start, q.end) : null;
  return {
    outcome: 'found', timeZone: HR_LOCAL_TZ,
    day: {
      date: q.date, dayType: day.kind, shiftCode: day.shiftCode, shiftStart: hhmm(day.shiftStart), shiftEnd: hhmm(day.shiftEnd),
      actualClockIn: hhmm(day.actualClockIn), actualClockOut: hhmm(day.actualClockOut),
      approvedOvertime: day.approvedOtPlan ? { start: hhmm(day.approvedOtPlan.start), end: hhmm(day.approvedOtPlan.end), minutes: day.approvedOtPlan.minutes } : null,
      review,
    },
  };
}

/** The leave pack's own refusal classes, by the export-name allowlist the M07 composition uses for leave. */
const isLeaveCreditDomainError = (e: unknown) => Object.entries(leave).some(([n, v]) =>
  /^(Replacement|Toil|LeaveCredit).*Error$/.test(n) && typeof v === 'function' && e instanceof (v as typeof Error));

/** A Leave Credit refusal as its v2 code (+ the domain's own sentence); anything else is rethrown (a 500). */
export function replacementLeaveRefusal(e: unknown): ReplacementLeaveRefusal {
  const refuse = (code: ReplacementLeaveRefusalCode): ReplacementLeaveRefusal => ({ outcome: 'refused', code, message: publicErrorMessage(e).slice(0, 4000) });
  if (e instanceof ModuleNotEnabledError) return refuse('module_off');
  if (e instanceof leave.ReplacementRequestDisabledError) return refuse('disabled');
  // Subclasses of ToilNotEligibleError first: each names a different thing to change.
  if (e instanceof leave.ToilFirstScheduleConsentRequiredError) return refuse('consent_required');
  if (e instanceof leave.LeaveCreditDayTypeMismatchError || e instanceof leave.LeaveCreditSectionMismatchError || e instanceof leave.ToilOrdinaryWorkingDayError) return refuse('day_type_mismatch');
  if (e instanceof leave.ToilExtendedHoursBelowThresholdError) return refuse('below_threshold');
  if (e instanceof leave.ReplacementRequestNotEligibleError || e instanceof leave.ToilNotEligibleError) return refuse('not_eligible');
  if (e instanceof leave.ToilAlreadyAccruedError) return refuse('already_credited');
  if (e instanceof ClaimOverlapError) return refuse('overtime_claimed');
  if (isLeaveCreditDomainError(e)) return refuse('invalid');
  throw e;
}

/**
 * Submit a Leave Credit request (submitLeaveCreditRequest, as app/leave/credit/actions.ts does: the tenant's
 * Replacement Leave type, the roster-adjudicated day types, the claimed windows, the reason, the consent), inside
 * the receipt's transaction. GRANTS NOTHING: a manager's approval mints the credit.
 */
export async function submitReplacementLeaveV2(ctx: SessionContext, employmentId: string, p: ReplacementLeaveCommand, locale: string): Promise<z.output<typeof ReplacementLeaveResult>> {
  if (!leaveCreditEnabled(ctx)) return { outcome: 'refused', code: 'module_off' };
  const type = pickReplacementLeaveType(await listLeaveTypes(ctx, { locale, includeArchived: false }));
  if (!type) return { outcome: 'refused', code: 'no_leave_type' };
  const rows = [...p.rows].sort((a, b) => a.workedDate.localeCompare(b.workedDate));
  const reason = p.reason.trim();
  return command<typeof ReplacementLeaveResult, ReplacementLeaveRefusal>(() => withMobileCommandReceipt(ctx, {
    kind: 'leave.credit-request', requestId: p.requestId, intent: { rows, reason, firstScheduleConsent: p.firstScheduleConsent },
    actorEmploymentId: employmentId, response: ReplacementLeaveResult,
  }, async (tx) => {
    const out = await leave.submitLeaveCreditRequest(ctx, {
      employmentId, leaveTypeId: type.id, rows: rows.map((r) => ({ workedDate: r.workedDate, dayType: r.dayType, claimStart: r.claimStart, claimEnd: r.claimEnd })),
      reason, firstScheduleConsent: p.firstScheduleConsent, today: todayInKualaLumpur(),
    }, tx);
    return { outcome: 'submitted' as const, id: out.requestId, totalDays: out.totalDays };
  }), replacementLeaveRefusal);
}
