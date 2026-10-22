/** Saved report -> real Payroll results -> comparison/export. Prepared during Board 2's resource
 * lease; execute only after the verified deployment handoff. No synthetic payslip inserts. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createMovementEvent } from '../core/movement';
import {
  getCustomReport, recordPayrollComparisonRun, runPayrollComparisonReport,
  saveCustomReport, updateCustomReport,
} from '../core/custom-reports';
import { payrollComparisonSpec } from '../core/report-payroll-comparison';
import {
  closeBatch, createBatch, createIndividualTxn, generatePayslips, setPayrollPermissionGrant,
  seedPayComponentCatalog, backfillEmploymentComponentsFromCompensation,
  listPayComponents,upsertPayComponent,setEmploymentPayComponent,createAdditionalRun,
} from '../packs/payroll/service';
import { requirePackFor } from '../localization/registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { previousPayrollComparisonPeriod } from '../lib/payroll-period-comparison';
import { serializePayrollComparison } from '../lib/payroll-comparison-export';
import {
  closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule,setSetting, type Base,
} from './harness';

let b: Base, ctx: SessionContext, previousPeriod: string, currentPeriod: string;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'typed_pay_components', 'disabled');
  ctx = { ...await entitledCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
  // Both result periods are complete calendar months before the actual KL fixture date.
  currentPeriod = previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0, 7));
  previousPeriod = previousPayrollComparisonPeriod(currentPeriod);
});

async function fixture(options: { typed?: boolean; allowance?: number } = {}) {
  const employee = await hireEmployee(ctx, {
    person: { fullName: 'Fictional Paid Result', primaryEmail: randomUUID() + '@fixture.test' },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time',
    employeeCode: 'COMPARE-001', hiredOn: previousPeriod + '-01',
  });
  await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 3000, monthlyAllowance: options.allowance ?? 0, effectiveFrom: previousPeriod + '-01' });
  await requirePackFor('MY').statutory.set(ctx, { personId: employee.personId, icNumber: '900101011234' });
  if (options.typed) {
    await seedPayComponentCatalog(ctx);
    await backfillEmploymentComponentsFromCompensation(ctx);
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    ctx = { ...await entitledCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
  }
  const previous = await createBatch(ctx, { companyId: b.companyId, payPeriod: previousPeriod });
  await generatePayslips(ctx, { batchId: previous.batchId });
  const current = await createBatch(ctx, { companyId: b.companyId, payPeriod: currentPeriod });
  const report = await saveCustomReport(ctx, {
    name: 'Fictional Basic comparison', datasetId: 'payroll_period_comparison',
    spec: payrollComparisonSpec(), companyIds: [b.companyId],
  });
  return { employee, previous, current, report };
}
function run(id: string, verb: 'view' | 'export' = 'view', actor = ctx) {
  return runPayrollComparisonReport(actor, [b.companyId], {
    id, verb, filters: { currentPeriod, previousPeriod },
  });
}
async function payrollSnapshot() {
  return {
    batches: await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.tenantId, b.tenantId)).orderBy(asc(s.payrollBatch.id)),
    results: await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId, b.tenantId)).orderBy(asc(s.payslip.id)),
    compensation: await owner.db.select().from(s.compensation).where(eq(s.compensation.tenantId, b.tenantId)).orderBy(asc(s.compensation.id)),
    employment: await owner.db.select().from(s.employment).where(eq(s.employment.tenantId, b.tenantId)).orderBy(asc(s.employment.id)),
  };
}

describe('Payroll comparison consumes generated paid results under the saved report authority', () => {
  it('keeps an actual mid-month exit and the same person later rehired as separate paid employments',async()=>{
    const f=await fixture();await closeBatch(ctx,{batchId:f.previous.batchId});
    await createMovementEvent(ctx,{employmentId:f.employee.employmentId,kind:'termination',effectiveDate:currentPeriod+'-10',
      endDate:currentPeriod+'-10',terminationReasonCode:'redundancy',remarks:'Fictional report lifecycle'});
    const rehire=await hireEmployee(ctx,{person:{id:f.employee.personId},companyId:b.companyId,departmentId:b.deptA,
      employmentType:'full_time',hiredOn:currentPeriod+'-20',employeeCode:'COMPARE-REHIRE'});
    await setCompensation(ctx,{employmentId:rehire.employmentId,basicSalary:3300,effectiveFrom:currentPeriod+'-20'});
    await generatePayslips(ctx,{batchId:f.current.batchId});const before=await payrollSnapshot();
    const view=await run(f.report.id),exported=await run(f.report.id,'export');
    expect(view.result.available).toBe(true);expect(view.result.rows).toHaveLength(2);
    expect(new Set(view.result.rows.map(row=>row.employmentId))).toEqual(new Set([f.employee.employmentId,rehire.employmentId]));
    const oldPaid=before.results.find(row=>row.batchId===f.current.batchId&&row.employmentId===f.employee.employmentId),
      newPaid=before.results.find(row=>row.batchId===f.current.batchId&&row.employmentId===rehire.employmentId);
    expect(oldPaid).toBeDefined();expect(newPaid).toBeDefined();
    expect(view.result.rows.find(row=>row.employmentId===f.employee.employmentId)).toMatchObject({previous:'3000.00',
      current:oldPaid!.basicSalary,reason:{reason:'proratedLeaving',effectiveDate:currentPeriod+'-10',prorated:true}});
    expect(view.result.rows.find(row=>row.employmentId===rehire.employmentId)).toMatchObject({previous:'0.00',
      current:newPaid!.basicSalary,previousPresent:false,currentPresent:true,variancePct:null,
      reason:{reason:'newHire',effectiveDate:currentPeriod+'-20',prorated:true}});
    expect(view.result.summary).toMatchObject({previousHeadcount:1,currentHeadcount:2,joiners:1,leavers:1});
    expect(exported.result.rows).toEqual(view.result.rows);expect(await payrollSnapshot()).toEqual(before);
  });

  it('keeps actual transferred employer segments dated and suppresses the transfer claim in a one-company scope',async()=>{
    const f=await fixture();await closeBatch(ctx,{batchId:f.previous.batchId});
    const [destination]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional comparison destination',country:'MY',currency:'MYR'}).returning();
    const [dept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:destination.id,name:'Fictional destination team'}).returning();
    const priorDestination=await createBatch(ctx,{companyId:destination.id,payPeriod:previousPeriod});
    await generatePayslips(ctx,{batchId:priorDestination.batchId});await closeBatch(ctx,{batchId:priorDestination.batchId});
    await createMovementEvent(ctx,{employmentId:f.employee.employmentId,kind:'entityTransfer',effectiveDate:currentPeriod+'-11',companyId:destination.id,departmentId:dept.id});
    const receiving=await createBatch(ctx,{companyId:destination.id,payPeriod:currentPeriod});
    await generatePayslips(ctx,{batchId:f.current.batchId});await generatePayslips(ctx,{batchId:receiving.batchId});
    const before=await payrollSnapshot(),scope=[b.companyId,destination.id];
    const result=await runPayrollComparisonReport(ctx,scope,{id:f.report.id,verb:'export',filters:{currentPeriod,previousPeriod}});
    expect(result.result.available).toBe(true);expect(result.result.rows).toHaveLength(2);
    for(const [companyId,batchId] of [[b.companyId,f.current.batchId],[destination.id,receiving.batchId]]){
      const paid=before.results.find(row=>row.batchId===batchId&&row.employmentId===f.employee.employmentId);expect(paid).toBeDefined();
      expect(result.result.rows.find(row=>row.companyId===companyId)).toMatchObject({employmentId:f.employee.employmentId,current:paid!.basicSalary,
        reason:{reason:'transfer',effectiveDate:currentPeriod+'-11'}});
    }
    const outgoing=result.result.rows.find(row=>row.companyId===b.companyId)!,incoming=result.result.rows.find(row=>row.companyId===destination.id)!;
    expect(outgoing.departmentId).toBe(b.deptA);expect(incoming.departmentId).toBe(dept.id);
    const limited=await run(f.report.id);expect(limited.result.available).toBe(true);expect(limited.result.rows).toHaveLength(1);
    expect(limited.result.rows[0].companyId).toBe(b.companyId);expect(limited.result.rows[0].reason.reason).not.toBe('transfer');
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('keeps actual saved currencies in separate totals after both company settings change',async()=>{
    const f=await fixture();await closeBatch(ctx,{batchId:f.previous.batchId});await generatePayslips(ctx,{batchId:f.current.batchId});
    const [foreignUnit]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second currency',country:'MY',currency:'SGD'}).returning();
    const [dept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:foreignUnit.id,name:'Fictional second currency team'}).returning();
    const other=await hireEmployee(ctx,{person:{fullName:'Fictional second currency employee',primaryEmail:randomUUID()+'@example.invalid'},
      companyId:foreignUnit.id,departmentId:dept.id,employmentType:'full_time',hiredOn:previousPeriod+'-01'});
    await setCompensation(ctx,{employmentId:other.employmentId,basicSalary:100,effectiveFrom:previousPeriod+'-01'});
    await requirePackFor('MY').statutory.set(ctx,{personId:other.personId,icNumber:'900101011235'});
    const previous=await createBatch(ctx,{companyId:foreignUnit.id,payPeriod:previousPeriod});await generatePayslips(ctx,{batchId:previous.batchId});await closeBatch(ctx,{batchId:previous.batchId});
    const current=await createBatch(ctx,{companyId:foreignUnit.id,payPeriod:currentPeriod});await generatePayslips(ctx,{batchId:current.batchId});
    await owner.db.update(s.company).set({currency:'USD'}).where(eq(s.company.id,foreignUnit.id));
    await owner.db.update(s.company).set({currency:'EUR'}).where(eq(s.company.id,b.companyId));
    const before=await payrollSnapshot(),result=await runPayrollComparisonReport(ctx,[b.companyId,foreignUnit.id],{id:f.report.id,verb:'export',filters:{currentPeriod,previousPeriod,onlyVariances:false}});
    expect(result.result.available).toBe(true);expect(result.result.rows).toHaveLength(2);
    expect(result.result.summary!.totals).toEqual(expect.arrayContaining([
      expect.objectContaining({currency:'MYR',previous:'3000.00',current:'3000.00',variance:'0.00'}),
      expect.objectContaining({currency:'SGD',previous:'100.00',current:'100.00',variance:'0.00'}),
    ]));expect(result.result.summary!.totals).toHaveLength(2);
    expect(result.result.rows.find(row=>row.employmentId===other.employmentId)?.currency).toBe('SGD');
    const file=await serializePayrollComparison(result,'xlsx'),book=XLSX.read(file.bytes,{type:'array'}),rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(book.Sheets.Details);
    expect(new Set(rows.map(row=>row.Currency))).toEqual(new Set(['MYR','SGD']));expect(await payrollSnapshot()).toEqual(before);
  });

  it('counts a generated one-off deduction once using its canonical component amount, preserving the separate signed record',async()=>{
    const f=await fixture({typed:true});
    await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',true);
    ctx={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
    const deduction=(await listPayComponents(ctx)).find(row=>row.code==='DEDUCTION');expect(deduction).toBeDefined();
    await createIndividualTxn(ctx,{batchId:f.previous.batchId,employmentId:f.employee.employmentId,kind:'deduction',
      txnDate:previousPeriod+'-10',amount:10.10,componentId:deduction!.id});
    await generatePayslips(ctx,{batchId:f.previous.batchId});await closeBatch(ctx,{batchId:f.previous.batchId});
    await createIndividualTxn(ctx,{batchId:f.current.batchId,employmentId:f.employee.employmentId,kind:'deduction',
      txnDate:currentPeriod+'-10',amount:10.11,componentId:deduction!.id});
    await generatePayslips(ctx,{batchId:f.current.batchId});
    const saved=await getCustomReport(ctx,f.report.id,[b.companyId]);expect(saved).not.toBeNull();
    const spec=structuredClone(saved!.spec);spec.payrollComparison!.payItemCode='DEDUCTION';
    await updateCustomReport(ctx,{id:saved!.id,name:saved!.name,version:saved!.version,spec,companyIds:[b.companyId]});
    const before=await payrollSnapshot();
    for(const row of before.results){
      expect(row.statutory).toMatchObject({recordLines:expect.arrayContaining([expect.objectContaining({code:'DEDUCTION',
        amount:row.batchId===f.previous.batchId?-10.10:-10.11,nonPayable:false})])});
      expect(row.statutory).toMatchObject({componentLines:expect.arrayContaining([expect.objectContaining({code:'DEDUCTION',
        amount:row.batchId===f.previous.batchId?10.10:10.11})])});
    }
    const view=await run(f.report.id),exported=await run(f.report.id,'export');
    expect(view.result.available).toBe(true);expect(view.result.rows).toHaveLength(1);
    expect(view.result.rows[0]).toMatchObject({previous:'10.10',current:'10.11',variance:'0.01',currency:'MYR'});
    expect(exported.result.rows).toEqual(view.result.rows);
    const file=await serializePayrollComparison(exported,'xlsx'),book=XLSX.read(file.bytes,{type:'array'});
    expect(XLSX.utils.sheet_to_json(book.Sheets.Details)).toEqual([expect.objectContaining({
      'Previous amount':10.10,'Current amount':10.11,Variance:0.01})]);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('keeps generated paid Basic independent of a recategorised BASIC display item',async()=>{
    const f=await fixture({typed:true});await closeBatch(ctx,{batchId:f.previous.batchId});
    const basic=(await listPayComponents(ctx)).find(row=>row.code==='BASIC');expect(basic).toBeDefined();
    await upsertPayComponent(ctx,{code:basic!.code,name:basic!.name,label:basic!.label,kind:basic!.kind,
      includedInEpf:basic!.includedInEpf,includedInSocsoEis:basic!.includedInSocsoEis,includedInPcb:basic!.includedInPcb,
      includedInHrdfBase:basic!.includedInHrdfBase,isNonPayable:basic!.isNonPayable,prorates:basic!.prorates,displayCategory:'bonus'});
    await generatePayslips(ctx,{batchId:f.current.batchId});const before=await payrollSnapshot();
    const result=await runPayrollComparisonReport(ctx,[b.companyId],{id:f.report.id,filters:{currentPeriod,previousPeriod,onlyVariances:false}});
    expect(result.result.available).toBe(true);expect(result.result.rows).toHaveLength(1);
    expect(result.result.rows[0]).toMatchObject({previous:'3000.00',current:'3000.00',variance:'0.00'});
    expect(before.results.map(row=>row.basicSalary)).toEqual(['3000.00','3000.00']);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('aggregates actual regular, bonus, off-cycle and adjustment payments without adding cumulative assessment bases',async()=>{
    const f=await fixture({typed:true});
    const bonus=(await listPayComponents(ctx)).find(row=>row.code==='BONUS');expect(bonus).toBeDefined();
    await setEmploymentPayComponent(ctx,{employmentId:f.employee.employmentId,componentId:bonus!.id,amount:100,effectiveFrom:previousPeriod+'-01'});
    await generatePayslips(ctx,{batchId:f.previous.batchId});await closeBatch(ctx,{batchId:f.previous.batchId});
    await setModule(b.tenantId,'multi_cycle_payroll','active');ctx={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
    await generatePayslips(ctx,{batchId:f.current.batchId});
    const additionalIds:string[]=[];
    for(const runType of ['bonus','off_cycle','adjustment'] as const){
      const additional=await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:currentPeriod,runType});
      additionalIds.push(additional.batchId);await generatePayslips(ctx,{batchId:additional.batchId});
    }
    const before=await payrollSnapshot();
    expect(before.results.filter(row=>additionalIds.includes(row.batchId))).toHaveLength(3);
    expect(before.results.filter(row=>additionalIds.includes(row.batchId)).every(row=>row.basicSalary==='0.00'&&row.bonus==='100.00')).toBe(true);
    const basic=await runPayrollComparisonReport(ctx,[b.companyId],{id:f.report.id,filters:{currentPeriod,previousPeriod,runType:'all',onlyVariances:false}});
    expect(basic.result.available).toBe(true);expect(basic.result.rows).toHaveLength(1);
    expect(basic.result.rows[0]).toMatchObject({previous:'3000.00',current:'3000.00',variance:'0.00'});
    const saved=await getCustomReport(ctx,f.report.id,[b.companyId]);expect(saved).not.toBeNull();
    const spec=structuredClone(saved!.spec);spec.payrollComparison!.payItemCode='BONUS';
    await updateCustomReport(ctx,{id:saved!.id,name:saved!.name,version:saved!.version,spec,companyIds:[b.companyId]});
    const regular=await run(f.report.id),all=await runPayrollComparisonReport(ctx,[b.companyId],{id:f.report.id,verb:'export',filters:{currentPeriod,previousPeriod,runType:'all'}});
    expect(regular.result.available).toBe(true);expect(regular.result.rows).toEqual([]);
    expect(all.result.available).toBe(true);expect(all.result.rows).toHaveLength(1);
    expect(all.result.rows[0]).toMatchObject({previous:'100.00',current:'400.00',variance:'300.00'});
    expect(all.sourceRevisions).toHaveLength(5);
    const file=await serializePayrollComparison(all,'xlsx'),book=XLSX.read(file.bytes,{type:'array'});
    expect(XLSX.utils.sheet_to_json(book.Sheets.Details)).toEqual([expect.objectContaining({'Previous amount':100,'Current amount':400,Variance:300})]);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('retains negative paid Basic variance and the latest of several actual salary movements',async()=>{
    const f=await fixture();await closeBatch(ctx,{batchId:f.previous.batchId});
    for(const [kind,day,basicSalary] of [['increment','01',3100],['promotion','10',3200],['demotion','20',2900]] as const)
      await createMovementEvent(ctx,{employmentId:f.employee.employmentId,kind,effectiveDate:currentPeriod+'-'+day,basicSalary,remarks:'Fictional comparison evidence'});
    await generatePayslips(ctx,{batchId:f.current.batchId});const before=await payrollSnapshot();
    const current=before.results.find(row=>row.batchId===f.current.batchId);expect(current).toBeDefined();
    const view=await run(f.report.id),exported=await run(f.report.id,'export');
    expect(view.result.available).toBe(true);expect(view.result.rows).toHaveLength(1);
    expect(view.result.rows[0]).toMatchObject({previous:'3000.00',current:current!.basicSalary,
      reason:{reason:'demotion',effectiveDate:currentPeriod+'-20',multipleChanges:true}});
    expect(view.result.rows[0].variance).toMatch(/^-\d+\.\d{2}$/);expect(view.result.rows[0].reason.evidenceIds).toHaveLength(3);
    expect(exported.result.rows).toEqual(view.result.rows);
    const file=await serializePayrollComparison(exported,'xlsx'),book=XLSX.read(file.bytes,{type:'array'});
    const rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(book.Sheets.Details);expect(rows).toHaveLength(1);expect(rows[0].Variance).toBeLessThan(0);
    expect(await payrollSnapshot()).toEqual(before);
  });
  it('compares another recorded pay item to the cent without substituting later compensation', async () => {
    const f = await fixture({ typed: true, allowance: 10.10 });
    await closeBatch(ctx, { batchId: f.previous.batchId });
    await setCompensation(ctx, { employmentId: f.employee.employmentId, basicSalary: 3000,
      monthlyAllowance: 10.11, effectiveFrom: currentPeriod + '-01' });
    await backfillEmploymentComponentsFromCompensation(ctx);
    await generatePayslips(ctx, { batchId: f.current.batchId });
    const saved = await getCustomReport(ctx, f.report.id, [b.companyId]);
    expect(saved).not.toBeNull();
    const spec = structuredClone(saved!.spec);
    spec.payrollComparison!.payItemCode = 'ALLOWANCE';
    await updateCustomReport(ctx, { id: saved!.id, name: saved!.name, version: saved!.version,
      spec, companyIds: [b.companyId] });
    await setCompensation(ctx, { employmentId: f.employee.employmentId, basicSalary: 9999,
      monthlyAllowance: 999, effectiveFrom: todayInKualaLumpur().slice(0, 7) + '-01' });
    const before = await payrollSnapshot(), view = await run(f.report.id), exported = await run(f.report.id, 'export');
    expect(view.result.available).toBe(true);
    expect(view.result.rows).toHaveLength(1);
    expect(view.result.rows[0]).toMatchObject({ employmentId: f.employee.employmentId,
      previous: '10.10', current: '10.11', variance: '0.01', currency: 'MYR' });
    expect(exported.result.rows).toEqual(view.result.rows);
    const file = await serializePayrollComparison(exported, 'xlsx');
    const book = XLSX.read(file.bytes, { type: 'array' });
    expect(XLSX.utils.sheet_to_json(book.Sheets.Details)).toEqual([expect.objectContaining({
      'Previous amount': 10.10, 'Current amount': 10.11, Variance: 0.01,
    })]);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('retains saved Basic instead of later master salary, with matching native workbook and metadata-only audit', async () => {
    const f = await fixture();
    await closeBatch(ctx, { batchId: f.previous.batchId });
    await createMovementEvent(ctx, {
      employmentId: f.employee.employmentId, kind: 'increment', effectiveDate: currentPeriod + '-01',
      basicSalary: 3200, remarks: 'Fictional recorded salary increase',
    });
    await generatePayslips(ctx, { batchId: f.current.batchId });
    // A later, genuine compensation revision must never be substituted for either saved result.
    await setCompensation(ctx, { employmentId: f.employee.employmentId, basicSalary: 9999, effectiveFrom: todayInKualaLumpur().slice(0, 7) + '-01' });
    const before = await payrollSnapshot();
    expect(before.results).toHaveLength(2);
    expect(before.results.find(row => row.batchId === f.previous.batchId)?.basicSalary).toBe('3000.00');
    expect(before.results.find(row => row.batchId === f.current.batchId)?.basicSalary).toBe('3200.00');
    const eventsBefore = await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(asc(s.domainEvent.sequence));
    const view = await run(f.report.id), exported = await run(f.report.id, 'export');
    expect(view.result).toMatchObject({ available: true, provisional: true, displayedRows: 1 });
    expect(view.result.rows).toHaveLength(1);
    expect(view.result.rows[0]).toMatchObject({ employmentId: f.employee.employmentId, previous: '3000.00', current: '3200.00', variance: '200.00', variancePct: '6.67', currency: 'MYR', reason: { reason: 'increment', effectiveDate: currentPeriod + '-01' } });
    expect(exported.result.rows).toEqual(view.result.rows); expect(exported.result.summary).toEqual(view.result.summary);
    expect(exported.sourceRevisions).toEqual(before.results.map(row => ({ id: row.id, version: row.version, runId: row.batchId })));
    expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(asc(s.domainEvent.sequence))).toEqual(eventsBefore);
    const file = await serializePayrollComparison(exported, 'xlsx');
    const workbook = XLSX.read(file.bytes, { type: 'array' });
    const details = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Details);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ 'Emp no.': 'COMPARE-001', 'Previous amount': 3000, 'Current amount': 3200, Variance: 200 });
    const auditId = await recordPayrollComparisonRun(ctx, exported, 'export', 'xlsx');
    const [audit] = await owner.db.select().from(s.customReportRun).where(eq(s.customReportRun.id, auditId));
    expect(audit).toMatchObject({ reportId: f.report.id, kind: 'export', format: 'xlsx', outcome: 'success', rowCount: 1 });
    const events = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, f.report.id), eq(s.domainEvent.eventType, 'custom-report.comparison-recorded'))).orderBy(asc(s.domainEvent.sequence));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ auditId, sourceRevisions: exported.sourceRevisions });
    for (const key of ['rows', 'employeeName', 'basicSalary', 'previous', 'current', 'variance']) expect(events[0].payload).not.toHaveProperty(key);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('refuses unclosed previous, uncalculated current and stale results before exposing any partial amounts', async () => {
    const f = await fixture();
    const unclosed = await run(f.report.id);
    expect(unclosed.result.available).toBe(false);
    expect(unclosed.result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['previousNotClosed', 'draftPayroll']));
    expect(unclosed.result.rows).toEqual([]); expect(unclosed.result.summary).toBeNull();
    await closeBatch(ctx, { batchId: f.previous.batchId });
    const draft = await run(f.report.id);
    expect(draft.result.issues.map(issue => issue.code)).toEqual(['draftPayroll']);
    expect(draft.result.rows).toEqual([]); expect(draft.result.summary).toBeNull();
    await generatePayslips(ctx, { batchId: f.current.batchId });
    expect((await run(f.report.id)).result).toMatchObject({ available: true, provisional: true });
    await createIndividualTxn(ctx, {
      batchId: f.current.batchId, employmentId: f.employee.employmentId,
      kind: 'earning', txnDate: currentPeriod + '-01', amount: 1,
    });
    const stale = await run(f.report.id, 'export');
    expect(stale.result.available).toBe(false); expect(stale.result.issues.map(issue => issue.code)).toContain('stalePayroll');
    expect(stale.result.rows).toEqual([]); expect(stale.result.summary).toBeNull();
  });

  it('distinguishes legacy item provenance from zero even when generated Basic is available', async () => {
    const f = await fixture(); await closeBatch(ctx, { batchId: f.previous.batchId });
    await generatePayslips(ctx, { batchId: f.current.batchId });
    expect((await run(f.report.id)).result.available).toBe(true);
    const saved = await getCustomReport(ctx, f.report.id, [b.companyId]); expect(saved).not.toBeNull();
    const spec = structuredClone(saved!.spec); spec.payrollComparison!.payItemCode = 'UNRECORDED_ITEM';
    await updateCustomReport(ctx, { id: saved!.id, name: saved!.name, version: saved!.version, spec, companyIds: [b.companyId] });
    const comparison = await run(f.report.id);
    expect(comparison.result.available).toBe(false);
    expect(comparison.result.issues).toHaveLength(2);
    expect(comparison.result.issues.every(issue => issue.code === 'itemNotRecorded')).toBe(true);
    expect(comparison.result.rows).toEqual([]); expect(comparison.result.summary).toBeNull();
  });

  it('enforces private ownership, saved export verbs, current salary permission and tenant scope on real results', async () => {
    const f = await fixture(); await closeBatch(ctx, { batchId: f.previous.batchId });
    await generatePayslips(ctx, { batchId: f.current.batchId });
    const [user] = await owner.db.insert(s.appUser).values({ tenantId: b.tenantId, workosUserId: 'comparison-' + randomUUID() }).returning({ id: s.appUser.id });
    await owner.db.insert(s.roleAssignment).values({ tenantId: b.tenantId, appUserId: user.id, role: 'hr_admin' });
    const peer = { ...ctx, userId: user.id };
    expect(await getCustomReport(peer, f.report.id, [b.companyId])).toBeNull();
    await expect(run(f.report.id, 'view', peer)).rejects.toThrow();
    await expect(run(f.report.id, 'export', peer)).rejects.toThrow();
    const saved = await getCustomReport(ctx, f.report.id, [b.companyId]); expect(saved).not.toBeNull();
    const spec = structuredClone(saved!.spec);
    spec.layout = { ...spec.layout, permissions: { hr_admin: ['view', 'create', 'edit', 'delete', 'share'] } };
    await updateCustomReport(ctx, { id: saved!.id, name: saved!.name, version: saved!.version, shared: true, spec, companyIds: [b.companyId] });
    const sharedView=await run(f.report.id, 'view', peer);
    expect(sharedView.result.available).toBe(true);expect(sharedView.canExport).toBe(false);
    await expect(run(f.report.id, 'export', peer)).rejects.toThrow();
    const before = await payrollSnapshot();
    await setPayrollPermissionGrant(ctx, { companyId: b.companyId, permissionKey: 'report.read.compensation', role: 'hr_admin', allowed: false });
    await expect(run(f.report.id, 'view', peer)).rejects.toThrow();
    await expect(run(f.report.id, 'export')).rejects.toThrow();
    const foreign = await seedBase();
    await expect(runPayrollComparisonReport(ctx, [foreign.companyId], { id: f.report.id, filters: { currentPeriod, previousPeriod } })).rejects.toThrow();
    expect(await payrollSnapshot()).toEqual(before);
  });
});
