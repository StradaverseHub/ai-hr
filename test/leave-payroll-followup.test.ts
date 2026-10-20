import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCancelLeave, decideLeave, decideLeaveDate, decideLeaveDates, decideLeaveCancellation, requestLeave, requestLeaveCancellation, LeaveCancellationPeriodClosedError } from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { erasePersonPii } from '../core/pdpa';
import { commitLeaveHistoryImport } from '../core/leave-history-import';
import { BatchNeedsRecalculationError, closeBatch, createBatch, createAdditionalRun, generatePayslips, setPayrollInput } from '../core/payroll';
import { assignPolicy, createPolicy } from '../core/payroll-policy';
import { LeavePayrollBusyError, LeavePayrollClosedError, listPayrollLeaveExceptions, resolvePayrollLeaveException } from '../core/payroll-leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

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
  const hiredSubject = await hire('Payroll subject'); const boss = await hire('Operational manager');
  const [employment] = await owner.db.select({ code: schema.employment.employeeCode }).from(schema.employment).where(eq(schema.employment.id, hiredSubject.employmentId));
  if(!employment.code)throw new Error('The hired payroll subject must have an employee code');
  subject = { ...hiredSubject, code: employment.code };
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
    allowNegativeBalance: true, maxNegativeBalance: '30', employeeCancelApproved: true,
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
  it('the manager coverage bridge exposes only segment coordinates, including when stored JSON contains extra private fields',async()=>{
    const leaveId=await pending(),batchId=await processed();
    await owner.db.update(schema.payslip).set({statutory:sql`statutory || ${JSON.stringify({segment:{companyId:b.companyId,from:`${lastMonth}-01`,to:addDays(`${today.slice(0,7)}-01`,-1),privateFinancialValue:'CONFIDENTIAL'}})}::jsonb`}).where(eq(schema.payslip.batchId,batchId));
    const coverage=await withTenant(manager,tx=>tx.execute(sql`select * from app.leave_payroll_coverage(ARRAY[${leaveId}::uuid])`));
    expect(coverage).toHaveLength(1);
    expect(JSON.stringify(coverage)).not.toContain('CONFIDENTIAL');
    expect(Object.keys(coverage[0])).not.toContain('net_pay');
  });
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
    await erasePersonPii(hr, { subjectEmploymentId: subject.employmentId, scope: 'all', reason: 'Exercise the existing authorised erasure process', requestRef: `ERASE/${randomUUID()}` });
    expect((await listPayrollLeaveExceptions(hr, batchId))[0]).toMatchObject({ status: 'resolved', explanation: null, resolution: 'no_adjustment' });
  });

  it('rechecks closed coverage under manager authority when a previously requested cancellation is decided', async () => {
    const leaveId = await pending(); await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    const batchId = await processed();
    const { cancellationRequestId } = await requestLeaveCancellation(employee, { leaveRequestId: leaveId, cancelDates: [tuesday], today: addDays(monday, -1) });
    await closeBatch(hr, { batchId });
    await expect(decideLeaveCancellation(manager, { cancellationRequestId, decision: 'approved' })).rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
    expect((await request(leaveId)).status).toBe('approved');
  });
  it('retains a real closed adjustment reference and deduplicates repeated source delivery', async () => {
    await setModule(b.tenantId,'multi_cycle_payroll','active');
    hr = {...hr,entitlements:harnessSnapshot(b.tenantId)};
    const leaveId=await pending();const batchId=await processed();
    const {batchId:adjustmentId}=await createAdditionalRun(hr,{companyId:b.companyId,payPeriod:lastMonth,runType:'adjustment',scope:{employmentIds:[subject.employmentId]}});
    await setPayrollInput(hr,{batchId:adjustmentId,employmentId:subject.employmentId,overtimeAmount:0,bonusAmount:100});
    await generatePayslips(hr,{batchId:adjustmentId});
    await closeBatch(hr,{batchId:adjustmentId});await closeBatch(hr,{batchId});
    await decideLeave(manager,{leaveRequestId:leaveId,decision:'approved'});
    const originalSlip=await slip(batchId),exceptions=await listPayrollLeaveExceptions(hr,batchId);
    expect(exceptions).toHaveLength(1);
    expect(await listPayrollLeaveExceptions(hr,adjustmentId)).toHaveLength(1);
    const {markPayrollAfterLeaveApprovalTx}=await import('../core/payroll-leave');
    await withTenant(manager,tx=>markPayrollAfterLeaveApprovalTx(tx,leaveId));
    expect(await listPayrollLeaveExceptions(hr,batchId)).toHaveLength(1);
    await resolvePayrollLeaveException(hr,{id:exceptions[0].id,batchId,resolution:'adjustment',adjustmentBatchId:adjustmentId,explanation:'Reviewed the existing closed adjustment for this employee and retained its canonical reference.'});
    expect((await listPayrollLeaveExceptions(hr,batchId))[0]).toMatchObject({status:'resolved',resolution:'adjustment',adjustment_batch_id:adjustmentId});
    expect(await slip(batchId)).toEqual(originalSlip);
  });
  it.each([true,false])('paid leave marks a processed run only when absence deductions are enabled (%s)',async deductAbsentDays=>{
    await owner.db.update(schema.leaveType).set({paid:true}).where(eq(schema.leaveType.id,typeId));
    const policy=await createPolicy(hr,{companyId:b.companyId,name:'Attendance absence policy',policyType:'monthly',config:{leave:{deductAbsentDays}}});
    await assignPolicy(hr,{employmentId:subject.employmentId,policyId:policy.id});
    const leaveId=await pending(),batchId=await processed(),before=await slip(batchId);
    await decideLeave(manager,{leaveRequestId:leaveId,decision:'approved'});
    expect((await batch(batchId)).recalcEmploymentIds??[]).toEqual(deductAbsentDays?[subject.employmentId]:[]);
    if(deductAbsentDays){
      await generatePayslips(hr,{batchId,reprocessSubset:{employmentIds:[subject.employmentId],reason:'Approved paid leave relieves the absence deduction'}});
      expect(Number((await slip(batchId)).netPay)).toBeGreaterThan(Number(before.netPay));
    }
  });
  it('marks absence relief immediately when an approved child date still has pending siblings',async()=>{
    await owner.db.update(schema.leaveType).set({paid:true,perDateApproval:true}).where(eq(schema.leaveType.id,typeId));
    const policy=await createPolicy(hr,{companyId:b.companyId,name:'Per-date absence relief',policyType:'monthly',config:{leave:{deductAbsentDays:true}}});
    await assignPolicy(hr,{employmentId:subject.employmentId,policyId:policy.id});
    const leaveId=await pending(),batchId=await processed(),before=await slip(batchId);
    await decideLeaveDate(manager,{leaveRequestId:leaveId,leaveDate:monday,decision:'approved'});
    expect((await request(leaveId)).status).toBe('pending');
    expect((await batch(batchId)).recalcEmploymentIds).toEqual([subject.employmentId]);
    await generatePayslips(hr,{batchId,reprocessSubset:{employmentIds:[subject.employmentId],reason:'One approved date already relieves absence'}});
    expect(Number((await slip(batchId)).netPay)).toBeGreaterThan(Number(before.netPay));
    await decideLeaveDates(manager,{leaveRequestId:leaveId,decisions:[tuesday,wednesday].map(leaveDate=>({leaveDate,decision:'rejected' as const,rejectReason:'These dates were not approved'}))});
    expect((await request(leaveId)).status).toBe('approved');
    expect((await batch(batchId)).needsRecalcAt).toBeNull();
  });
  it('retains earlier closed-run resolution history when a later child date is approved',async()=>{
    await owner.db.update(schema.leaveType).set({paid:true,perDateApproval:true}).where(eq(schema.leaveType.id,typeId));
    const policy=await createPolicy(hr,{companyId:b.companyId,name:'Closed per-date absence relief',policyType:'monthly',config:{leave:{deductAbsentDays:true}}});
    await assignPolicy(hr,{employmentId:subject.employmentId,policyId:policy.id});
    const leaveId=await pending(),batchId=await processed();await closeBatch(hr,{batchId});const before=await slip(batchId);
    await decideLeaveDate(manager,{leaveRequestId:leaveId,leaveDate:monday,decision:'approved'});
    const [first]=await listPayrollLeaveExceptions(hr,batchId);expect(first.affected_dates).toEqual([monday]);
    await resolvePayrollLeaveException(hr,{id:first.id,batchId,resolution:'no_adjustment',explanation:'The first approved date has been reviewed independently.'});
    await decideLeaveDate(manager,{leaveRequestId:leaveId,leaveDate:tuesday,decision:'approved'});
    await decideLeaveDate(manager,{leaveRequestId:leaveId,leaveDate:wednesday,decision:'rejected',rejectReason:'The remaining date is not approved'});
    const rows=await listPayrollLeaveExceptions(hr,batchId);expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.id===first.id)).toMatchObject({status:'resolved',explanation:'The first approved date has been reviewed independently.'});
    expect(rows.find(row=>row.id!==first.id)).toMatchObject({status:'open',affected_dates:[tuesday]});
    expect(await slip(batchId)).toEqual(before);
  });
  it.each(['weekly','biweekly'] as const)('protects %s cycle disbursements when the leave start is outside the monthly deduction window',async frequency=>{
    const policy=await createPolicy(hr,{companyId:b.companyId,name:`${frequency} disbursement`,policyType:'monthly',config:{frequency}});
    await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,defaultPayrollPolicyId:policy.id,unpaidLeaveCutOffDay:Number(monday.slice(8))});
    // A real deduction already belongs to this leave window, outside its salary cycles. The later
    // approval changes how that fixed deduction is allocated, while its monthly total stays fixed.
    const earlier=addDays(monday,-7);
    const prior=await requestLeave(employee,{employmentId:subject.employmentId,leaveTypeId:typeId,startDate:earlier,endDate:earlier,today:addDays(earlier,-30)});
    await decideLeave(manager,{leaveRequestId:prior.leaveRequestId,decision:'approved'});
    const leaveId=await pending(),batchId=await processed(),before=await slip(batchId);
    await decideLeave(manager,{leaveRequestId:leaveId,decision:'approved'});
    expect((await batch(batchId)).recalcEmploymentIds).toEqual([subject.employmentId]);
    await generatePayslips(hr,{batchId,reprocessSubset:{employmentIds:[subject.employmentId],reason:'Approved leave changes the scheduled cycle weighting'}});
    const after=await slip(batchId);
    expect(after.netPay).toBe(before.netPay);
    expect((after.statutory as Record<string,unknown>).paymentSchedule).not.toEqual((before.statutory as Record<string,unknown>).paymentSchedule);
    await closeBatch(hr,{batchId});
    await expect(requestLeaveCancellation(employee,{leaveRequestId:leaveId,cancelDates:[monday],today:addDays(monday,-1)})).rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
  });
  it('uses the former paying company cut-off and denies an HR reviewer scoped only to the new company',async()=>{
    await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,unpaidLeaveCutOffDay:Number(tuesday.slice(8))});
    const leaveId=await pending(),batchId=await processed();await closeBatch(hr,{batchId});
    const before=await slip(batchId);
    const [current]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional new employing company'}).returning();
    await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:current.id,unpaidLeaveCutOffDay:Number(monday.slice(8))});
    // A coverage fixture: retain the actual old payslip and assignment, while current employment differs.
    await owner.db.update(schema.employment).set({companyId:current.id}).where(eq(schema.employment.id,subject.employmentId));
    await decideLeave(manager,{leaveRequestId:leaveId,decision:'approved'});
    const exceptions=await listPayrollLeaveExceptions(hr,batchId);expect(exceptions).toHaveLength(1);
    expect(await slip(batchId)).toEqual(before);
    const [reviewerPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional scoped reviewer',primaryEmail:`${randomUUID()}@reviewer.invalid`}).returning();
    const reviewer=await createAppUser(b.tenantId,reviewerPerson.id,'hr_admin');
    await owner.db.update(schema.roleAssignment).set({companyId:current.id}).where(eq(schema.roleAssignment.appUserId,reviewer));
    const scoped={tenantId:b.tenantId,userId:reviewer,roles:['hr_admin'],entitlements:harnessSnapshot(b.tenantId)};
    expect(await listPayrollLeaveExceptions(scoped,batchId)).toEqual([]);
    await expect(resolvePayrollLeaveException(scoped,{id:exceptions[0].id,batchId,resolution:'no_adjustment',explanation:'This reviewer must not resolve another company payroll.'})).rejects.toThrow();
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
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(1);
    expect(await listPayrollLeaveExceptions(hr, batchId)).toHaveLength(openingBalancesAreNet ? 0 : 1);
    expect(await slip(batchId)).toEqual(originalSlip);
  });

  it.each(['neither', 'original', 'survivor'] as const)('a first-day split tracks both cutoff windows and refuses either closed run (%s closed)', async closed => {
    const cutoff = Number(tuesday.slice(8));
    await owner.db.insert(schema.companyPayrollConfig).values({ tenantId: b.tenantId, companyId: b.companyId, unpaidLeaveCutOffDay: cutoff })
      .onConflictDoUpdate({ target: schema.companyPayrollConfig.companyId, set: { unpaidLeaveCutOffDay: cutoff } });
    const leaveId = await pending(); await decideLeave(manager, { leaveRequestId: leaveId, decision: 'approved' });
    const original = await processed();
    const nextPeriod = addDays(`${lastMonth}-28`, 5).slice(0, 7);
    const survivor = await processed(nextPeriod);
    const beforeOriginal = await slip(original), beforeSurvivor = await slip(survivor);
    if (closed !== 'neither') {
      await closeBatch(hr, { batchId: closed === 'original' ? original : survivor });
      await expect(requestLeaveCancellation(employee, { leaveRequestId: leaveId, cancelDates: [monday], today: addDays(monday, -1) }))
        .rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
      expect((await request(leaveId)).status).toBe('approved');
      expect(await slip(original)).toEqual(beforeOriginal); expect(await slip(survivor)).toEqual(beforeSurvivor);
    } else {
      const { cancellationRequestId } = await requestLeaveCancellation(employee, { leaveRequestId: leaveId, cancelDates: [monday], today: addDays(monday, -1) });
      await decideLeaveCancellation(manager, { cancellationRequestId, decision: 'approved' });
      expect((await batch(original)).recalcEmploymentIds).toEqual([subject.employmentId]);
      expect((await batch(survivor)).recalcEmploymentIds).toEqual([subject.employmentId]);
      for (const batchId of [original, survivor]) await generatePayslips(hr, { batchId, reprocessSubset: { employmentIds: [subject.employmentId], reason: 'First-day cancellation moved the unpaid attribution' } });
      expect(Number((await slip(original)).netPay)).toBeGreaterThan(Number(beforeOriginal.netPay));
      expect(Number((await slip(survivor)).netPay)).toBeLessThan(Number(beforeSurvivor.netPay));
    }
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
