/**
 * M07 · D5 (owner, 2026-10-28) — the three kernel seams the native leave commands need, and the web path they
 * must leave untouched:
 *   (a) an optional trailing `existingTx` on cancelOwnLeave, requestLeaveCancellation, decideLeave,
 *       decideLeaveDates and decideLeaveCancellation: passed ⇒ the work joins the caller's transaction (it rolls
 *       back with it — the property the mobile command receipt depends on); omitted ⇒ its own, as before;
 *   (b) an optional `expectedStepIndex` on the three decisions: the pending step the caller saw, or null for "no
 *       step rows". Moved ⇒ LeaveStaleStepError (code stale_step) and nothing written; omitted ⇒ the web's
 *       existing refusals, byte for byte;
 *   (c) previewLeaveDeduction takes an hourly From/To window and returns the days requestLeave deducts, through
 *       the same factored rule (hourlyLeaveWindow + hourlyLeaveDays); with no window it keeps its 0.5 placeholder.
 * Dates derive from todayInKualaLumpur(); nothing hard-codes a future date.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  cancelOwnLeave, decideLeave, decideLeaveCancellation, decideLeaveDates, hourlyLeaveDays, hourlyLeaveWindow, hoursBetween,
  HourlyLeaveTimeRangeError, LeaveStaleStepError, previewLeaveDeduction, requestLeave, requestLeaveCancellation, DEFAULT_STANDARD_HOURS,
} from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext, mgrCtx: SessionContext, hrCtx: SessionContext;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MON = (() => { let d = addDays(TODAY, 8); while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1); return d; })();
const FRI = addDays(MON, 4);
const SENTINEL = new Error('caller rolls back');

const hire = (name: string) => hireEmployee(adminCtx(b), {
  person: { fullName: name, primaryEmail: `seam_${randomUUID().slice(0, 8)}@t.local` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
});
const ctxOf = async (e: { personId: string }, role: string): Promise<SessionContext> => ({ tenantId: b.tenantId, userId: await createAppUser(b.tenantId, e.personId, role), personId: e.personId, roles: [role] });
const status = async (id: string) => (await owner.db.select({ s: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)))[0]?.s;
const steps = (id: string) => owner.db.select({ stepIndex: schema.leaveApprovalStep.stepIndex, status: schema.leaveApprovalStep.status }).from(schema.leaveApprovalStep).where(eq(schema.leaveApprovalStep.leaveRequestId, id)).orderBy(schema.leaveApprovalStep.stepIndex);
const cancellations = (id: string) => owner.db.select({ id: schema.leaveCancellationRequest.id, status: schema.leaveCancellationRequest.status }).from(schema.leaveCancellationRequest).where(eq(schema.leaveCancellationRequest.leaveRequestId, id));
const apply = (startDate = MON, endDate = FRI) => requestLeave(subjectCtx, { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate, endDate, today: TODAY });
async function policy(levels: string[]) { await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: levels as never }); }
async function approved(startDate = MON, endDate = FRI) {
  const { leaveRequestId } = await apply(startDate, endDate);
  while ((await status(leaveRequestId)) === 'pending') {
    const pending = (await steps(leaveRequestId)).find((s) => s.status === 'pending');
    await decideLeave(pending?.stepIndex === 1 ? hrCtx : mgrCtx, { leaveRequestId, decision: 'approved' });
  }
  return leaveRequestId;
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await policy(['direct_manager', 'hr_admin']);
  subject = await hire('Seam Subject');
  subjectCtx = await ctxOf(subject, 'employee');
  const manager = await hire('Seam Manager');
  mgrCtx = await ctxOf(manager, 'manager');
  hrCtx = await ctxOf(await hire('Seam HR'), 'hr_admin');
  await setReportingLine(adminCtx(b), { subordinateEmploymentId: subject.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
  await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '30.00', effectiveOn: TODAY });
});

describe('D5(a) existingTx: the work joins the caller’s transaction; omitted, it runs on its own as before', () => {
  it('cancelOwnLeave rolls back with the caller, commits with it, and the web call is unchanged', async () => {
    const one = (await apply()).leaveRequestId;
    await expect(withTenant(subjectCtx, async (tx) => { await cancelOwnLeave(subjectCtx, { leaveRequestId: one }, tx); expect(await status(one)).toBe('pending'); throw SENTINEL; })).rejects.toBe(SENTINEL);
    expect(await status(one), 'rolled back with the caller (an own transaction would have committed)').toBe('pending');
    await withTenant(subjectCtx, (tx) => cancelOwnLeave(subjectCtx, { leaveRequestId: one }, tx));
    expect(await status(one)).toBe('cancelled');
    const two = (await apply(addDays(MON, 7), addDays(FRI, 7))).leaveRequestId;
    expect(await cancelOwnLeave(subjectCtx, { leaveRequestId: two })).toEqual({ previousStatus: 'pending', restoredDays: 0 });
    expect(await status(two)).toBe('cancelled');
  });

  it('requestLeaveCancellation rolls back with the caller; the web call still records a pending cancellation', async () => {
    const id = await approved();
    await expect(withTenant(subjectCtx, async (tx) => { await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [FRI], today: TODAY }, tx); throw SENTINEL; })).rejects.toBe(SENTINEL);
    expect(await cancellations(id)).toEqual([]);
    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [FRI], today: TODAY });
    expect(out.status).toBe('pending');
    expect(await cancellations(id)).toEqual([{ id: out.cancellationRequestId, status: 'pending' }]);
  });

  it('decideLeave and decideLeaveCancellation roll back with the caller', async () => {
    const { leaveRequestId } = await apply();
    await expect(withTenant(mgrCtx, async (tx) => { await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' }, tx); throw SENTINEL; })).rejects.toBe(SENTINEL);
    expect((await steps(leaveRequestId)).map((s) => s.status)).toEqual(['pending', 'pending']);
    const id = await approved(addDays(MON, 7), addDays(FRI, 7));
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [addDays(FRI, 7)], today: TODAY });
    await expect(withTenant(mgrCtx, async (tx) => { await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'rejected' }, tx); throw SENTINEL; })).rejects.toBe(SENTINEL);
    expect((await cancellations(id))[0].status).toBe('pending');
    expect((await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'rejected' })).status).toBe('rejected');
  });
});

describe('D5(b) expectedStepIndex: a moved chain is stale_step and writes nothing; omitted, the web refusals stand', () => {
  it('decideLeave: the right step advances, a wrong or old one is stale, and the web path still says “already approved”', async () => {
    const { leaveRequestId } = await apply();
    const wrong = await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: 1 }).catch((e) => e);
    expect(wrong).toBeInstanceOf(LeaveStaleStepError);
    expect((wrong as LeaveStaleStepError).code).toBe('stale_step');
    expect((await steps(leaveRequestId)).map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: 0 })).toMatchObject({ status: 'pending' });
    // Someone else's view, opened before level 1 cleared, is now stale — for HR too, who could clear any step.
    await expect(decideLeave(hrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: 0 })).rejects.toBeInstanceOf(LeaveStaleStepError);
    expect((await steps(leaveRequestId)).map((s) => s.status)).toEqual(['approved', 'pending']);
    expect(await decideLeave(hrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: 1 })).toEqual({ status: 'approved' });
    await expect(decideLeave(hrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: 1 })).rejects.toBeInstanceOf(LeaveStaleStepError);
    const web = await decideLeave(hrCtx, { leaveRequestId, decision: 'approved' }).catch((e) => e);
    expect(web).not.toBeInstanceOf(LeaveStaleStepError);
    expect((web as Error).message).toBe('leave request is already approved');
  });

  it('decideLeave on a single-level chain (no step rows) expects null', async () => {
    await policy(['direct_manager']);
    const { leaveRequestId } = await apply();
    expect(await steps(leaveRequestId)).toEqual([]);
    await expect(decideLeave(mgrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: 0 })).rejects.toBeInstanceOf(LeaveStaleStepError);
    expect(await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved', expectedStepIndex: null })).toEqual({ status: 'approved' });
  });

  it('decideLeaveDates (per-date, single-level) expects null, refuses anything else, and the web call is unchanged', async () => {
    await policy(['direct_manager']);
    await owner.db.update(schema.leaveType).set({ counting: 'working_days', perDateApproval: true }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const one = (await apply()).leaveRequestId;
    const dates = (rows: { leaveDate: string }[]) => rows.map((d) => ({ leaveDate: d.leaveDate, decision: 'approved' as const }));
    const perDate = await owner.db.select({ leaveDate: schema.leaveRequestDate.leaveDate, status: schema.leaveRequestDate.status }).from(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId, one));
    expect(perDate.length).toBeGreaterThan(0);
    await expect(decideLeaveDates(mgrCtx, { leaveRequestId: one, decisions: dates(perDate), expectedStepIndex: 0 })).rejects.toBeInstanceOf(LeaveStaleStepError);
    expect((await owner.db.select({ s: schema.leaveRequestDate.status }).from(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId, one))).every((r) => r.s === 'pending')).toBe(true);
    await decideLeaveDates(mgrCtx, { leaveRequestId: one, decisions: dates(perDate), expectedStepIndex: null });
    expect(await status(one)).toBe('approved');
    await expect(decideLeaveDates(mgrCtx, { leaveRequestId: one, decisions: dates(perDate), expectedStepIndex: null })).rejects.toBeInstanceOf(LeaveStaleStepError);
    const web = await decideLeaveDates(mgrCtx, { leaveRequestId: one, decisions: dates(perDate) }).catch((e) => e);
    expect((web as Error).message).toBe('leave request is already approved');
    // Rolled back with a caller's transaction.
    const two = (await apply(addDays(MON, 7), addDays(FRI, 7))).leaveRequestId;
    const twoDates = await owner.db.select({ leaveDate: schema.leaveRequestDate.leaveDate }).from(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId, two));
    await expect(withTenant(mgrCtx, async (tx) => { await decideLeaveDates(mgrCtx, { leaveRequestId: two, decisions: dates(twoDates) }, tx); throw SENTINEL; })).rejects.toBe(SENTINEL);
    expect(await status(two)).toBe('pending');
  });

  it('decideLeaveCancellation walks its copied chain by the expected step', async () => {
    const id = await approved();
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [FRI], today: TODAY });
    const copied = await owner.db.select({ stepIndex: schema.leaveCancellationStep.stepIndex }).from(schema.leaveCancellationStep).where(eq(schema.leaveCancellationStep.cancellationRequestId, cancellationRequestId)).orderBy(schema.leaveCancellationStep.stepIndex);
    expect(copied.map((s) => s.stepIndex)).toEqual([0, 1]);
    await expect(decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved', expectedStepIndex: null })).rejects.toBeInstanceOf(LeaveStaleStepError);
    expect(await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved', expectedStepIndex: 0 })).toMatchObject({ status: 'pending' });
    await expect(decideLeaveCancellation(hrCtx, { cancellationRequestId, decision: 'approved', expectedStepIndex: 0 })).rejects.toBeInstanceOf(LeaveStaleStepError);
    expect(await decideLeaveCancellation(hrCtx, { cancellationRequestId, decision: 'approved', expectedStepIndex: 1 })).toMatchObject({ status: 'approved' });
    await expect(decideLeaveCancellation(hrCtx, { cancellationRequestId, decision: 'approved', expectedStepIndex: 1 })).rejects.toBeInstanceOf(LeaveStaleStepError);
    const web = await decideLeaveCancellation(hrCtx, { cancellationRequestId, decision: 'approved' }).catch((e) => e);
    expect((web as Error).message).toBe('cancellation request is already approved');
  });
});

describe('D5(c) hourly preview: the figure requestLeave deducts, by the same rule', () => {
  it('the factored rule is the 0129 rule: window hours, raw back-compat hours, the bounds and the 8-hour denominator', () => {
    expect(hourlyLeaveWindow({ fromTime: '09:00:00', toTime: '11:30' })).toEqual({ hours: 2.5, fromTime: '09:00', toTime: '11:30' });
    expect(hourlyLeaveWindow({ hours: 3 })).toEqual({ hours: 3, fromTime: null, toTime: null });
    expect(() => hourlyLeaveWindow({})).toThrow(HourlyLeaveTimeRangeError);
    expect(() => hourlyLeaveWindow({ fromTime: '09:00' })).toThrow(HourlyLeaveTimeRangeError);
    expect(() => hourlyLeaveWindow({ fromTime: '22:00', toTime: '02:00' })).toThrow(HourlyLeaveTimeRangeError);
    for (const h of [0.42, 1, 2.5, 9, 24]) expect(hourlyLeaveDays(h)).toBe(Math.round((h / DEFAULT_STANDARD_HOURS) * 100) / 100);
    expect(() => hourlyLeaveDays(0)).toThrow();
    expect(() => hourlyLeaveDays(24.5)).toThrow();
    expect(() => hourlyLeaveDays(null)).toThrow();
    expect(hoursBetween('09:00', '09:25')).toBe(0.42);
  });

  for (const counting of ['calendar_days', 'working_days'] as const) {
    it(`${counting}: preview days equal the persisted deduction for each window; overnight is refused by both`, async () => {
      await owner.db.update(schema.leaveType).set({ counting, durations: ['half_day_am', 'half_day_pm', 'hourly'] }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
      const windows = [['09:00', '11:00'], ['09:00', '18:00'], ['13:15', '17:40'], ['08:05', '08:30']] as const;
      for (const [i, [fromTime, toTime]] of windows.entries()) {
        const day = addDays(MON, i);
        const p = { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: day, endDate: day, durationType: 'hourly' as const, fromTime, toTime, today: TODAY };
        const preview = await previewLeaveDeduction(subjectCtx, p);
        const submitted = await requestLeave(subjectCtx, p);
        const [row] = await owner.db.select({ days: schema.leaveRequest.days }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, submitted.leaveRequestId));
        expect(preview.days, `${fromTime}–${toTime}`).toBe(submitted.days);
        expect(Number(row.days)).toBe(preview.days);
      }
      const night = { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: addDays(MON, 7), endDate: addDays(MON, 7), durationType: 'hourly' as const, fromTime: '22:00', toTime: '02:00', today: TODAY };
      await expect(previewLeaveDeduction(subjectCtx, night)).rejects.toBeInstanceOf(HourlyLeaveTimeRangeError);
      await expect(requestLeave(subjectCtx, night)).rejects.toBeInstanceOf(HourlyLeaveTimeRangeError);
      expect(await owner.db.select({ id: schema.leaveRequest.id }).from(schema.leaveRequest).where(and(eq(schema.leaveRequest.employmentId, subject.employmentId), eq(schema.leaveRequest.startDate, addDays(MON, 7))))).toEqual([]);
    });
  }

  it('web regression: no window keeps the 0.5 placeholder; half days and full days are unchanged', async () => {
    await owner.db.update(schema.leaveType).set({ durations: ['half_day_am', 'half_day_pm', 'hourly'] }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const p = { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: MON, today: TODAY };
    expect((await previewLeaveDeduction(subjectCtx, { ...p, durationType: 'hourly' })).days).toBe(0.5);
    expect((await previewLeaveDeduction(subjectCtx, { ...p, durationType: 'half_day_am' })).days).toBe(0.5);
    expect((await previewLeaveDeduction(subjectCtx, { ...p, durationType: 'half_day_pm', fromTime: '09:00', toTime: '10:00' })).days, 'a window on a non-hourly duration is ignored').toBe(0.5);
    const full = await previewLeaveDeduction(subjectCtx, { ...p, endDate: FRI });
    const submitted = await requestLeave(subjectCtx, { ...p, endDate: FRI });
    expect(full.days).toBe(submitted.days);
  });
});
