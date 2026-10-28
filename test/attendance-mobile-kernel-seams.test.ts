/**
 * M12 (D13) — the kernel seams the mobile attendance composition needed, each optional and backward-compatible:
 *
 *   myAttendanceCorrections          unchanged rows and order for every web caller (no cursor text leaks out);
 *   myAttendanceCorrectionsPage      the same read, strictly past a keyset `before`, optionally narrowed to `ids`;
 *   myAttendanceCorrectionCounts     per stored status, the same scope;
 *   cancelOwnAttendanceCorrection    the caller's transaction (a rollback undoes the withdrawal) and the typed
 *                                    AttendanceWithdrawRefusedError with the SAME sentences as before;
 *   submitReplacementLeaveRequest    the caller's transaction (a rollback leaves no request);
 *   submitLeaveCreditRequest         the caller's transaction for the roster adjudication too.
 *
 * Omitting every new argument is the pre-M12 behaviour; the web callers pass none of them.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  AttendanceWithdrawRefusedError, cancelOwnAttendanceCorrection, decideAttendanceCorrection, myAttendanceCorrectionCounts,
  myAttendanceCorrections, myAttendanceCorrectionsPage, requestAttendanceCorrection,
} from '../core/attendance';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import { listReplacementLeaveRequests, submitReplacementLeaveRequest } from '../core/replacement-request';
import { LeaveCreditDayTypeMismatchError, submitLeaveCreditRequest } from '../core/leave-credit-request';
import { adminCtx, closeAll, createAppUser, entitledCtx, harnessSnapshot, migrateTestDb, resetDb, seedBase, setModule, owner, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });

async function employee(departmentId?: string) {
  const e = await hireEmployee(adminCtx(b), { person: { fullName: 'Seam Worker', primaryEmail: randomUUID() + '@seam.test' }, companyId: b.companyId, departmentId: departmentId ?? b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: b.companyId }], entitlements: harnessSnapshot(b.tenantId) };
  return { ...e, ctx };
}
const ROLLBACK = 'fixture rollback';

describe('own attendance requests — the shared read', () => {
  it('myAttendanceCorrections is unchanged; the page reads the same rows in the same order, past a keyset, narrowed by ids', async () => {
    const me = await employee();
    const ids: string[] = [];
    for (const date of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'])
      ids.push((await requestAttendanceCorrection(me.ctx, { employmentId: me.employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: `Fix ${date}` })).correctionId);
    await decideAttendanceCorrection(adminCtx(b), { correctionId: ids[1], decision: 'rejected', rejectReason: 'Fixture rejection explanation' });

    const web = await myAttendanceCorrections(me.ctx, me.employmentId);
    expect(web.map((r) => r.id)).toEqual([...ids].reverse());
    for (const row of web) expect(Object.keys(row)).not.toContain('cursorAt');
    const page = await myAttendanceCorrectionsPage(me.ctx, me.employmentId, { limit: 10 });
    expect(page.map(({ cursorAt: _c, ...row }) => row)).toEqual(web);
    for (const row of page) expect(row.cursorAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const [first, second] = page;
    const rest = await myAttendanceCorrectionsPage(me.ctx, me.employmentId, { limit: 10, before: { date: second.attendanceDate, at: second.cursorAt, id: second.id } });
    expect(rest.map((r) => r.id)).toEqual(page.slice(2).map((r) => r.id));
    expect((await myAttendanceCorrectionsPage(me.ctx, me.employmentId, { limit: 10, ids: [first.id] })).map((r) => r.id)).toEqual([first.id]);
    expect(await myAttendanceCorrectionsPage(me.ctx, me.employmentId, { limit: 10, ids: [] })).toEqual([]);
    expect((await myAttendanceCorrectionsPage(me.ctx, me.employmentId, { limit: 10, status: 'rejected' })).map((r) => r.id)).toEqual([ids[1]]);
    expect(await myAttendanceCorrectionCounts(me.ctx, me.employmentId)).toEqual({ pending: 3, approved: 0, rejected: 1, cancelled: 0 });
  });
});

describe('cancelOwnAttendanceCorrection', () => {
  it('runs in the caller’s transaction when given one, and refuses with the typed error and the same sentences', async () => {
    const me = await employee();
    const { correctionId } = await requestAttendanceCorrection(me.ctx, { employmentId: me.employmentId, date: '2026-06-01', checkIn: '09:00', checkOut: '18:00', reason: 'r' });
    await expect(withTenant(me.ctx, async (tx) => { await cancelOwnAttendanceCorrection(me.ctx, { correctionId }, tx); throw new Error(ROLLBACK); })).rejects.toThrow(ROLLBACK);
    expect((await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, correctionId)))[0].status, 'rolled back with the caller').toBe('pending');
    expect(await cancelOwnAttendanceCorrection(me.ctx, { correctionId })).toEqual({ status: 'cancelled' });

    const decided = (await requestAttendanceCorrection(me.ctx, { employmentId: me.employmentId, date: '2026-06-02', checkIn: '09:00', checkOut: '18:00', reason: 'r' })).correctionId;
    await decideAttendanceCorrection(adminCtx(b), { correctionId: decided, decision: 'approved' });
    const late = cancelOwnAttendanceCorrection(me.ctx, { correctionId: decided });
    await expect(late).rejects.toBeInstanceOf(AttendanceWithdrawRefusedError);
    await expect(late).rejects.toMatchObject({ refusal: 'not_pending', message: 'This request is no longer waiting for a decision, so it can no longer be withdrawn.' });

    const [plan] = await owner.db.insert(schema.attendanceCorrection).values({ tenantId: b.tenantId, employmentId: me.employmentId, attendanceDate: '2026-06-03', requestedOtMinutes: 60, reason: 'Overtime plan' }).returning({ id: schema.attendanceCorrection.id });
    await expect(cancelOwnAttendanceCorrection(me.ctx, { correctionId: plan.id })).rejects.toMatchObject({ refusal: 'overtime', message: 'This is an overtime plan — withdraw it from the Self Overtime list.' });
  });
});

describe('Leave Credit submission', () => {
  const SATURDAY = '2026-07-04'; // a rest day under the seeded company's working week (test/replacement-leave-request.test.ts)
  const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({ companyId: b.companyId, enabled: true, accrualBasis: 'hours_worked', expiryDays: 90, onExpiry: 'convert_to_pay',
    allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false, employeeRequestEnabled: true, ...over });

  it('submitReplacementLeaveRequest writes in the caller’s transaction when given one; omitted, as before', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    const ctx = await entitledCtx(b);
    const e = await hireEmployee(ctx, { person: { fullName: 'RL Seam', primaryEmail: randomUUID() + '@seam.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
    await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await setToilPolicy(ctx, policy());
    const input = { employmentId: e.employmentId, unit: 'day' as const, lines: [{ workedDate: SATURDAY, days: 1 }], today: '2026-07-20' };
    await expect(withTenant(ctx, async (tx) => { await submitReplacementLeaveRequest(ctx, input, tx); throw new Error(ROLLBACK); })).rejects.toThrow(ROLLBACK);
    expect(await listReplacementLeaveRequests(ctx, e.employmentId), 'rolled back with the caller').toEqual([]);
    const inTx = await withTenant(ctx, (tx) => submitReplacementLeaveRequest(ctx, input, tx));
    const listed = await listReplacementLeaveRequests(ctx, e.employmentId);
    expect(listed.map((r) => r.id)).toEqual([inTx.requestId]);
  });

  it('submitLeaveCreditRequest adjudicates the day type inside the caller’s transaction too', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    const ctx = await entitledCtx(b);
    const e = await hireEmployee(ctx, { person: { fullName: 'Credit Seam', primaryEmail: randomUUID() + '@seam.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
    await setToilPolicy(ctx, policy());
    const p = { employmentId: e.employmentId, rows: [{ workedDate: SATURDAY, dayType: 'workday' as const, claimStart: '09:00', claimEnd: '17:00' }], reason: 'Covered the stock take', today: '2026-07-20' };
    // A Saturday is not an ordinary working day for this company: refused the same way with and without a transaction.
    await expect(submitLeaveCreditRequest(ctx, p)).rejects.toBeInstanceOf(LeaveCreditDayTypeMismatchError);
    await expect(withTenant(ctx, (tx) => submitLeaveCreditRequest(ctx, p, tx))).rejects.toBeInstanceOf(LeaveCreditDayTypeMismatchError);
    expect(await listReplacementLeaveRequests(ctx, e.employmentId)).toEqual([]);
  });
});
