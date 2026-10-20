import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCancelLeave, decideLeave, decideLeaveCancellation, requestLeave, requestLeaveCancellation, LeaveCancellationPeriodClosedError } from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { commitLeaveHistoryImport } from '../core/leave-history-import';
import { BatchNeedsRecalculationError, closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { LeavePayrollBusyError, LeavePayrollClosedError, listPayrollLeaveExceptions, resolvePayrollLeaveException } from '../core/payroll-leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const today = todayInKualaLumpur();
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
const monday = (() => { let date = `${lastMonth}-01`; while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) date = addDays(date, 1); return date; })();
const tuesday = addDays(monday, 1), wednesday = addDays(monday, 2);
let b: Base, hr: SessionContext, employee: SessionContext, manager: SessionContext;
let subject: { employmentId: string; personId: string; code: string };
let typeId: string;

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); hr = adminCtx(b);
  const hire = (name: string) => hireEmployee(hr, {
    person: { fullName: name, primaryEmail: `${randomUUID()}@leave-payroll.test` }, companyId: b.companyId,
    departmentId: b.deptA, employmentType: 'full_time', hiredOn: addDays(today, -800),
  });
  subject = await hire('Payroll subject'); const boss = await hire('Operational manager');
  const userId = await createAppUser(b.tenantId, subject.personId, 'employee');
  const bossId = await createAppUser(b.tenantId, boss.personId, 'manager');
  employee = { tenantId: b.tenantId, userId, personId: subject.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };
  manager = { tenantId: b.tenantId, userId: bossId, personId: boss.personId, roles: ['manager'], entitlements: harnessSnapshot(b.tenantId) };
  await setReportingLine(hr, { subordinateEmploymentId: subject.employmentId, managerEmploymentId: boss.employmentId, lineType: 'administrative', validFrom: addDays(today, -700) });
  await setLeaveApprovalPolicy(hr, { companyId: b.companyId, levels: ['direct_manager'] });
  await setCompensation(hr, { employmentId: subject.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: addDays(today, -800) });
  await setStatutoryProfileMY(hr, { personId: subject.personId, icNumber: '900101015201' });
  const [type] = await owner.db.insert(schema.leaveType).values({
    tenantId: b.tenantId, code: 'UNPAID', name: 'Unpaid leave', paid: false, counting: 'working_days',
    allowNegativeBalance: true, employeeCancelApproved: true,
  }).returning(); typeId = type.id;
});
afterAll(closeAll);

async function pending(type = typeId) {
  return (await requestLeave(employee, { employmentId: subject.employmentId, leaveTypeId: type,
    startDate: monday, endDate: wednesday, today: addDays(monday, -30) })).leaveRequestId;
}
async function processed(period = lastMonth) {
  const { batchId } = await createBatch(hr, { companyId: b.companyId, payPeriod: period, scope: { employmentIds: [subject.employmentId] } });
  await generatePayslips(hr, { batchId }); return batchId;
}
const batch = async (id: string) => (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, id)))[0];
const slip = async (id: string) => (await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, id), eq(schema.payslip.employmentId, subject.employmentId))))[0];
const request = async (id: string) => (await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)))[0];

describe('leave decisions and payroll follow-up', () => {
  it('a manager approval marks exactly the affected employee, blocks close, and reprocessing changes real pay and clears the mark', async () => {
    const leaveId = await pending(); const batchId = await processed(); const before = await slip(batchId);
    expect((await batch(batchId)).needsRecalcAt).toBeNull();
    await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    expect((await batch(batchId)).recalcEmploymentIds).toEqual([subject.employmentId]);
    await expect(closeBatch(hr, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);
    const visibleSlips = await withTenant(manager, tx => tx.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)));
    expect(visibleSlips).toEqual([]);
    await generatePayslips(hr, { batchId, reprocessSubset: { employmentIds: [subject.employmentId], reason: 'Approved unpaid leave' } });
    expect(Number((await slip(batchId)).netPay)).toBeLessThan(Number(before.netPay));
    expect((await batch(batchId)).needsRecalcAt).toBeNull();
    expect((await batch(batchId)).recalcEmploymentIds ?? []).toEqual([]);
  });

  it('closed-run approval creates an HR-only exception, changes no payslip, and records a retained no-adjustment resolution', async () => {
    const leaveId = await pending(); const batchId = await processed(); await closeBatch(hr, { batchId });
    const originalSlip = await slip(batchId), originalBatch = await batch(batchId);
    await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    expect(await slip(batchId)).toEqual(originalSlip); expect(await batch(batchId)).toEqual(originalBatch);
    const exceptions = await listPayrollLeaveExceptions(hr, batchId);
    expect(exceptions).toHaveLength(1); expect(exceptions[0].status).toBe('open');
    expect(await listPayrollLeaveExceptions(manager, batchId)).toEqual([]);
    await expect(resolvePayrollLeaveException(manager, { id: exceptions[0].id, batchId, resolution: 'no_adjustment', explanation: 'Manager cannot resolve this payroll exception.' })).rejects.toThrow();
    await expect(resolvePayrollLeaveException(hr, { id: exceptions[0].id, batchId, resolution: 'adjustment', adjustmentBatchId: randomUUID(), explanation: 'A fabricated adjustment is not valid evidence.' })).rejects.toThrow();
    await resolvePayrollLeaveException(hr, { id: exceptions[0].id, batchId, resolution: 'no_adjustment', explanation: 'Reviewed against the external payroll correction; no additional adjustment is needed.' });
    const resolved = await listPayrollLeaveExceptions(hr, batchId);
    expect(resolved[0]).toMatchObject({ status: 'resolved', resolution: 'no_adjustment', explanation: expect.stringContaining('Reviewed') });
    expect(await slip(batchId)).toEqual(originalSlip);
    const history = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, exceptions[0].id)).orderBy(schema.domainEvent.sequence);
    expect(history.map(event => event.eventType)).toEqual(['payroll-leave-exception.opened', 'payroll-leave-exception.resolved']);
  });

  it('rechecks closed coverage under manager authority when a previously requested cancellation is decided', async () => {
    const leaveId = await pending(); await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    const batchId = await processed();
    const { cancellationRequestId } = await requestLeaveCancellation(employee, { leaveRequestId: leaveId, cancelDates: [tuesday], today: addDays(monday, -1) });
    await closeBatch(hr, { batchId });
    await expect(decideLeaveCancellation(manager, { cancellationRequestId, decision: 'approved' })).rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
    expect((await request(leaveId)).status).toBe('approved');
  });

  it('pending HR cancellation creates no stale marker or closed exception', async () => {
    const leaveId = await pending(); const batchId = await processed(); await closeBatch(hr, { batchId });
    await adminCancelLeave(hr, { leaveRequestId: leaveId, reason: 'Withdraw pending request' });
    expect((await request(leaveId)).status).toBe('cancelled');
    expect(await listPayrollLeaveExceptions(hr, batchId)).toEqual([]);
    expect((await batch(batchId)).needsRecalcAt).toBeNull();
  });

  it('paid-status changes refuse closed effects atomically while an unchanged save is harmless', async () => {
    const leaveId = await pending(); await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    const batchId = await processed(); await closeBatch(hr, { batchId });
    await updateLeaveType(hr, { id: typeId, name: 'Unpaid leave', paid: false });
    await expect(updateLeaveType(hr, { id: typeId, name: 'Unpaid leave', paid: true })).rejects.toBeInstanceOf(LeavePayrollClosedError);
    expect((await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, typeId)))[0].paid).toBe(false);
  });

  it.each([true, false])('charged-history import follows the same closed-run workflow (opening balances net=%s)', async openingBalancesAreNet => {
    const batchId = await processed(); await closeBatch(hr, { batchId }); const originalSlip = await slip(batchId);
    const result = await commitLeaveHistoryImport(hr, { openingBalancesAreNet, records: [{
      employee_no: subject.code, leave_reference: `OLD/${randomUUID()}`, leave_code: 'UNPAID',
      entitlement_year: monday.slice(0, 4), leave_start_date: monday, leave_end_date: wednesday,
      number_of_day: '3', session: '', entry_date: '', submit_date: '', approved_date: '', remark: 'Historical migration',
    }] });
    expect(result.imported).toBe(1);
    expect(await listPayrollLeaveExceptions(hr, batchId)).toHaveLength(openingBalancesAreNet ? 0 : 1);
    expect(await slip(batchId)).toEqual(originalSlip);
  });

  it('a busy payroll writer refuses and rolls back the leave decision instead of deadlocking', async () => {
    const leaveId = await pending(); const batchId = await processed();
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const writer = withTenant(hr, async tx => { await tx.execute(sql`select id from payroll_batch where id=${batchId}::uuid for update`); acquired(); await hold; });
    await ready;
    try { await expect(decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' })).rejects.toBeInstanceOf(LeavePayrollBusyError); }
    finally { release(); await writer; }
    expect((await request(leaveId)).status).toBe('pending');
    expect((await batch(batchId)).needsRecalcAt).toBeNull();
    await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    expect((await batch(batchId)).recalcEmploymentIds).toEqual([subject.employmentId]);
  });
});
