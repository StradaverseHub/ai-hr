/** ADR-0106: real resolver, real RLS and real payroll projection; no mocked qualification or gates. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, entitledCtx, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, setAttendancePolicy } from '../packs/attendance/service';
import { createBatch, deleteDraftBatch, seedPayComponentCatalog, AllowancePayrollConflictError } from '../packs/payroll/service';
import { allowancePeriods, allowanceTransferHistory, createAllowancePolicy, emptyAllowanceRules, evaluateAllowancesForPeriod, StaleAllowancePreviewError, transferAllowancesToBatch, updateAllowancePolicy, type AllowanceRules } from '../packs/attendance/service';
import { monthDates } from '../lib/roster-month';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;
const year = Number(todayInKualaLumpur().slice(0, 4)) - 1;
const month = `${year}-08`;
const workedDates = monthDates(month).filter(date => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day > 0 && day < 6;
}).slice(0, 2);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });

async function fixture() {
  const a = adminCtx(b);
  await setAttendancePolicy(a, {companyId:b.companyId, workStart:'09:00', workEnd:'18:00', breakMinutes:60, lateAfter:'09:15', halfDayBefore:'13:00', workingDays:[1,2,3,4,5]});
  const employees: string[] = [];
  for (const name of ['Allowance recipient', 'Other recipient']) {
    const { employmentId } = await hireEmployee(a, {person:{fullName:name, primaryEmail:`${randomUUID()}@allowance.test`}, companyId:b.companyId, departmentId:b.deptA, employmentType:'full_time', hiredOn:`${year}-01-01`});
    employees.push(employmentId);
    for (const date of workedDates) {
      await checkIn(a, {employmentId, date, time:'09:00:00'});
      await checkOut(a, {employmentId, date, time:'18:00:00'});
    }
  }
  await seedPayComponentCatalog(a);
  const [component] = await owner.db.select().from(schema.payComponent).where(and(eq(schema.payComponent.tenantId,b.tenantId),eq(schema.payComponent.code,'ATTENDANCE')));
  await setModule(b.tenantId,'typed_pay_components','active');
  const ctx = await entitledCtx(b);
  const rules = emptyAllowanceRules();
  rules.employee = {mode:'selected', employmentIds:[employees[0]], logic:'and', criteria:[]};
  rules.attendance.criteria = [{field:'attendanceDays', operator:'gte', value:'1', unit:'days'}];
  async function policy(code: string, amount = '0.10', override: Partial<{rules:AllowanceRules;method:string;policyType:'earning'|'deduction';payComponentId:string}> = {}) {
    return createAllowancePolicy(a, {companyId:b.companyId, code, name:code, amount, payComponentId:component.id, effectiveFrom:`${year}-01-01`, method:'daily', rules, ...override});
  }
  return {a, ctx, employees, componentId:component.id, rules, policy};
}
async function componentAmount(batchId:string, employmentId:string, componentId:string) {
  const rows = await owner.db.select().from(schema.payrollBatchComponent).where(and(eq(schema.payrollBatchComponent.batchId,batchId),eq(schema.payrollBatchComponent.employmentId,employmentId),eq(schema.payrollBatchComponent.componentId,componentId)));
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.amount ?? null;
}
async function sources(batchId:string) {
  return owner.db.select().from(schema.payrollAttendanceAllowanceSource).where(eq(schema.payrollAttendanceAllowanceSource.batchId,batchId));
}

describe('source-owned allowance periods', () => {
  it('previews real recorded attendance, limits the selected payroll scope, and pays each qualifying day once', async () => {
    const f = await fixture();
    const rules = emptyAllowanceRules();
    rules.attendance.criteria = f.rules.attendance.criteria;
    const {id} = await f.policy('DAILY','0.10',{rules});
    const unscoped = await evaluateAllowancesForPeriod(f.ctx,{policyId:id,month});
    expect(unscoped.rows).toHaveLength(2); // a scope assertion cannot pass on an empty preview
    expect(unscoped.rows.every(row => row.amount === '0.20')).toBe(true);
    expect(unscoped.rows[0].periods.filter(p => p.qualified).map(p => p.from)).toEqual(workedDates);
    expect(unscoped.rows[0].periods.filter(p => p.qualified).every(p => p.attendanceIds.length === 1 && p.metrics.actualMinutes === 480)).toBe(true);
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month,scope:{employmentIds:[f.employees[0]]}});
    const preview = await evaluateAllowancesForPeriod(f.ctx,{policyId:id,month,batchId});
    expect(preview.rows.map(row => row.employmentId)).toEqual([f.employees[0]]);
    expect(await transferAllowancesToBatch(f.ctx,{policyId:id,batchId,expectedDigest:preview.inputDigest})).toMatchObject({applied:1,gated:false});
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.20');
    expect(await componentAmount(batchId,f.employees[1],f.componentId)).toBeNull();
    expect(await sources(batchId)).toHaveLength(2);
    await expect(withTenant(f.ctx,tx=>tx.update(schema.payrollBatchComponent).set({amount:'99.99'}).where(and(eq(schema.payrollBatchComponent.batchId,batchId),eq(schema.payrollBatchComponent.employmentId,f.employees[0]))))).rejects.toThrow();
    await transferAllowancesToBatch(f.ctx,{policyId:id,batchId,expectedDigest:preview.inputDigest});
    expect(await sources(batchId)).toHaveLength(2);
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.20');
    await Promise.all([1,2].map(()=>transferAllowancesToBatch(f.ctx,{policyId:id,batchId,expectedDigest:preview.inputDigest})));
    expect(await sources(batchId)).toHaveLength(2);
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.20');
  });

  it('uses a Sunday-owned crossing week once and preserves fixed monthly and daily amounts without proration', async () => {
    const f = await fixture();
    const crossing = Array.from({length:6},(_,i)=>`${year}-${String(i+2).padStart(2,'0')}`)
      .flatMap(m=>allowancePeriods('weekly',m).filter(p=>p.from.slice(0,7)!==m).map(p=>({...p,month:m})))[0];
    expect(crossing).toBeDefined();
    for(const date of [crossing.from,crossing.to]){
      await checkIn(f.a,{employmentId:f.employees[0],date,time:'09:00:00'});
      await checkOut(f.a,{employmentId:f.employees[0],date,time:'18:00:00'});
    }
    const weekly = await f.policy('CROSS_WEEK','17.25',{method:'weekly'});
    const preview = await evaluateAllowancesForPeriod(f.ctx,{policyId:weekly.id,month:crossing.month});
    expect(preview.rows).toHaveLength(1);expect(preview.rows[0].amount).toBe('17.25');
    expect(preview.rows[0].periods.filter(p=>p.qualified)).toHaveLength(1);
    expect(preview.rows[0].periods.find(p=>p.key===crossing.key)?.eligibleDates).toContain(crossing.from);
    const monthly = await f.policy('FIXED_MONTH','99.99',{method:'monthly'});
    const daily = await f.policy('FIXED_DAY','0.50');
    expect((await evaluateAllowancesForPeriod(f.ctx,{policyId:monthly.id,month:crossing.month})).rows[0].amount).toBe('99.99');
    expect((await evaluateAllowancesForPeriod(f.ctx,{policyId:daily.id,month:crossing.month})).rows[0].amount).toBe('0.50');
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:crossing.month});
    await transferAllowancesToBatch(f.ctx,{policyId:weekly.id,batchId});
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('17.25');
    expect(await sources(batchId)).toHaveLength(1);
  });

  it('sums two policies on the same code exactly and replaces only the changed policy while preserving revisions', async () => {
    const f = await fixture();
    const p = await f.policy('FIRST','0.10'), q = await f.policy('SECOND','0.20');
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    await transferAllowancesToBatch(f.ctx,{policyId:q.id,batchId});
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.60');
    expect(await sources(batchId)).toHaveLength(4);
    const before = await allowanceTransferHistory(f.ctx,p.id);
    expect(before.results.filter(r=>r.qualified)).toHaveLength(2);
    expect(before.revisions.some(r=>r.amount==='0.10')).toBe(true);
    await updateAllowancePolicy(f.a,{id:p.id,amount:'0.30'});
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('1.00');
    expect((await sources(batchId)).filter(s=>s.policyId===q.id).map(s=>s.amount)).toEqual(['0.20','0.20']);
    const after = await allowanceTransferHistory(f.ctx,p.id);
    expect(after.versions.map(v=>v.version)).toEqual([2,1]);
    expect(after.results.filter(r=>r.policyVersion===1&&r.qualified).every(r=>r.status==='superseded')).toBe(true);
    expect(after.revisions.filter(r=>r.amount==='0.10')).toHaveLength(before.revisions.filter(r=>r.amount==='0.10').length);
    // A correction disqualifies ONE daily period. Another policy's original amount remains untouched.
    await owner.db.delete(schema.attendance).where(and(eq(schema.attendance.employmentId,f.employees[0]),eq(schema.attendance.attendanceDate,workedDates[0])));
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.70');
    expect((await sources(batchId)).filter(s=>s.policyId===p.id)).toHaveLength(1);
    const corrected = await allowanceTransferHistory(f.ctx,p.id);
    expect(corrected.revisions.length).toBeGreaterThan(after.revisions.length);
  });

  it('refuses a stale preview and an unrelated payroll input atomically, retaining resolvable failure receipts', async () => {
    const f = await fixture(), p = await f.policy('CONFLICT');
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    const preview = await evaluateAllowancesForPeriod(f.ctx,{policyId:p.id,month,batchId});
    await updateAllowancePolicy(f.a,{id:p.id,amount:'0.20'});
    await expect(transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId,expectedDigest:preview.inputDigest})).rejects.toBeInstanceOf(StaleAllowancePreviewError);
    expect(await sources(batchId)).toHaveLength(0);
    await owner.db.insert(schema.payrollBatchComponent).values({tenantId:b.tenantId,batchId,employmentId:f.employees[0],componentId:f.componentId,amount:'0.40',notes:'Operator input'});
    await expect(transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId})).rejects.toBeInstanceOf(AllowancePayrollConflictError);
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.40');
    expect(await sources(batchId)).toHaveLength(0);
    let history = await allowanceTransferHistory(f.ctx,p.id);
    expect(history.results).toHaveLength(0); // every provisional calculation rolled back
    expect(history.attempts.map(a=>a.errorCode)).toEqual(expect.arrayContaining(['stalePreview','payrollConflict']));
    await owner.db.delete(schema.payrollBatchComponent).where(eq(schema.payrollBatchComponent.batchId,batchId));
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    history = await allowanceTransferHistory(f.ctx,p.id);
    expect(history.attempts.some(a=>a.status==='transferred')).toBe(true);
    expect(history.attempts.filter(a=>a.status==='failed')).toHaveLength(2);
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.40');
  });

  it('requires processed-run consent, marks recalculation, and refuses closed money or evidence changes', async () => {
    const f = await fixture(), p = await f.policy('LOCKED');
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    await owner.db.update(schema.payrollBatch).set({status:'processed'}).where(eq(schema.payrollBatch.id,batchId));
    await updateAllowancePolicy(f.a,{id:p.id,amount:'0.25'});
    await expect(transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId})).rejects.toThrow();
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.20');
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId,reprocess:true});
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
    expect(batch.needsRecalcAt).not.toBeNull();
    expect(batch.recalcEmploymentIds).toContain(f.employees[0]);
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.50');
    // Setting status is fixture setup, not a claim that a run without payslips can pass closeBatch.
    await owner.db.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,batchId));
    await expect(transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId,reprocess:true})).rejects.toThrow();
    const [source] = await sources(batchId);
    await expect(withTenant(f.ctx,tx=>tx.update(schema.attendanceAllowanceResult).set({amount:'0.00'}).where(eq(schema.attendanceAllowanceResult.id,source.resultId)))).rejects.toThrow();
    await expect(withTenant(f.ctx,tx=>tx.delete(schema.payrollAttendanceAllowanceSource).where(eq(schema.payrollAttendanceAllowanceSource.id,source.id)))).rejects.toThrow();
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBe('0.50');
  });

  it('draft teardown releases current sources, preserves original run references and can safely transfer to a replacement draft', async () => {
    const f = await fixture(), p = await f.policy('TEARDOWN');
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    const prior = await allowanceTransferHistory(f.ctx,p.id);
    expect(prior.attempts).toHaveLength(1);expect(prior.revisions.length).toBeGreaterThan(0);
    await deleteDraftBatch(f.ctx,{batchId});
    expect(await sources(batchId)).toHaveLength(0);
    const retained = await allowanceTransferHistory(f.ctx,p.id);
    expect(retained.attempts[0]).toMatchObject({batchId:null,batchRef:batchId,status:'transferred'});
    expect(retained.revisions.map(r=>r.id).sort()).toEqual(prior.revisions.map(r=>r.id).sort());
    const replacement = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId:replacement.batchId});
    expect(await componentAmount(replacement.batchId,f.employees[0],f.componentId)).toBe('0.20');
    expect(await sources(replacement.batchId)).toHaveLength(2);
  });

  it('keeps Attendance setup and previews available without Payroll while refusing a money transfer', async () => {
    const f = await fixture(), p = await f.policy('NO_PAYROLL');
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    await setModule(b.tenantId,'payroll',null);
    const ctx = await entitledCtx(b);
    const preview = await evaluateAllowancesForPeriod(ctx,{policyId:p.id,month,batchId});
    expect(preview.rows).toHaveLength(1);expect(preview.rows[0].amount).toBe('0.20');
    await expect(transferAllowancesToBatch(ctx,{policyId:p.id,batchId})).rejects.toThrow();
    expect(await sources(batchId)).toHaveLength(0);
    expect(await componentAmount(batchId,f.employees[0],f.componentId)).toBeNull();
    await setModule(b.tenantId,'attendance',null);
    const noAttendance = await entitledCtx(b);
    await expect(evaluateAllowancesForPeriod(noAttendance,{policyId:p.id,month})).rejects.toThrow();
  });

  it('enforces compatible deduction codes and protects immutable audit rows and employee visibility at the app role', async () => {
    const f = await fixture();
    await expect(f.policy('BADTYPE','1.00',{policyType:'deduction'})).rejects.toThrow();
    const [deduction] = await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'ATT_DEDUCT',name:'Attendance deduction',kind:'deduction',includedInEpf:false,includedInSocsoEis:false,includedInPcb:false}).returning();
    const p = await f.policy('DEDUCT','1.25',{policyType:'deduction',payComponentId:deduction.id});
    const {batchId} = await createBatch(f.a,{companyId:b.companyId,payPeriod:month});
    await transferAllowancesToBatch(f.ctx,{policyId:p.id,batchId});
    expect(await componentAmount(batchId,f.employees[0],deduction.id)).toBe('2.50');
    const history = await allowanceTransferHistory(f.ctx,p.id);
    expect(history.versions).toHaveLength(1);expect(history.revisions.length).toBeGreaterThan(0);
    await expect(withTenant(f.ctx,tx=>tx.update(schema.attendanceAllowanceVersion).set({snapshot:{}}).where(eq(schema.attendanceAllowanceVersion.id,history.versions[0].id)))).rejects.toThrow();
    await expect(withTenant(f.ctx,tx=>tx.delete(schema.attendanceAllowanceResultRevision).where(eq(schema.attendanceAllowanceResultRevision.id,history.revisions[0].id)))).rejects.toThrow();
    const [employment] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id,f.employees[0]));
    const userId = await createAppUser(b.tenantId,employment.personId,'employee');
    const employeeCtx:SessionContext = {tenantId:b.tenantId,userId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
    await expect(allowanceTransferHistory(employeeCtx,p.id)).rejects.toThrow();
    const invisible = await withTenant(employeeCtx,tx=>tx.select().from(schema.attendanceAllowanceResultRevision));
    expect(invisible).toHaveLength(0);
    const [source] = await sources(batchId);
    await expect(withTenant(f.ctx,tx=>tx.insert(schema.payrollAttendanceAllowanceSource).values({...source,id:randomUUID(),periodKey:'forged'}))).rejects.toThrow();
    expect(await sources(batchId)).toHaveLength(2);
  });
});
