import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import * as payrollGate from '../core/module-gate';
import { packFor } from '../localization/registry';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, reprocessSelectedEmployees, getReprocessJob, decodeReprocessEmployeeOutcomes, listReprocessEmployeeOutcomes, PayrollReprocessStoppedError, type ReprocessJobResult } from '../core/payroll';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, createAppUser, type Base } from './harness';

describe('r382 selected reprocess exact employee outcomes', () => {
 let base:Base; let ctx:SessionContext; let icCounter=800000;
 beforeAll(migrateTestDb);
 beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'multi_cycle_payroll','active');ctx=await entitledCtx(base);icCounter=800000;});
 afterAll(closeAll);
 async function hire(name:string,basic=3000) {
  const e=await hireEmployee(ctx,{person:{fullName:name,primaryEmail:`${randomUUID()}@r382.test`},companyId:base.companyId,
   departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:`900101${++icCounter}`});
  await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:basic,monthlyAllowance:0,effectiveFrom:'2024-01-01',remarks:basic===0?'No monthly salary; payable transactions only':undefined});
  return e;
 }
 async function slip(batchId:string,employmentId:string){return (await owner.db.select().from(schema.payslip)
  .where(and(eq(schema.payslip.batchId,batchId),eq(schema.payslip.employmentId,employmentId))))[0];}
 async function batch(batchId:string){return (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId)))[0];}
 async function zero(e:{employmentId:string}){await owner.db.update(schema.compensation).set({basicSalary:'0.00',remarks:'No monthly salary'})
  .where(and(eq(schema.compensation.employmentId,e.employmentId),isNull(schema.compensation.validTo)));}
 async function run(employmentIds:string[],batchId:string,key=randomUUID()) {
  await reprocessSelectedEmployees(ctx,{batchId,employmentIds,idempotencyKey:key});
  const jobs=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey,key));
  return {job:jobs[0],result:jobs[0].result as ReprocessJobResult,key};
 }
 it('mixed selection commits payable employees and skips no-pay while retaining exact saved result, transactions and dirty marker',async()=>{
  const a=await hire('Payable A'),b=await hire('No payable B'),c=await hire('Payable C');
  const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const oldB=await slip(batchId,b.employmentId);await zero(b);
  const [txn]=await owner.db.insert(schema.payrollIndividualTxn).values({tenantId:base.tenantId,batchId,companyId:base.companyId,payPeriod:'2026-05',
   employmentId:b.employmentId,kind:'deduction',txnDate:'2026-05-12',amount:'20.00',consumedBatchId:batchId,consumedAt:new Date()}).returning();
  await owner.db.update(schema.payrollBatch).set({needsRecalcAt:new Date(),recalcEmploymentIds:[b.employmentId]}).where(eq(schema.payrollBatch.id,batchId));
  const {result,job,key}=await run([a.employmentId,b.employmentId,c.employmentId],batchId);
  expect(job.status).toBe('completed');expect(result.reprocessed).toBe(2);expect(result.skipped).toBe(1);
  expect(result.outcomes.find(r=>r.employmentId===b.employmentId)).toMatchObject({status:'skipped',reasonCode:'NOTHING_PAYABLE',resultRetained:true,
   historyId:null,payslipId:oldB.id,versionBefore:oldB.version,versionAfter:oldB.version,name:'No payable B'});
  expect(await slip(batchId,b.employmentId)).toEqual(oldB);
  expect((await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id,txn.id)))[0]).toEqual(txn);
  expect((await batch(batchId)).recalcEmploymentIds).toContain(b.employmentId);
  expect((await slip(batchId,a.employmentId)).version).toBe(2);expect((await slip(batchId,c.employmentId)).version).toBe(2);
  const history=await owner.db.select().from(schema.payrollEmployeeResultHistory).where(eq(schema.payrollEmployeeResultHistory.batchId,batchId));
  expect(history).toHaveLength(2);for(const r of result.outcomes.filter(r=>r.status==='reprocessed'))expect(history.find(h=>h.id===r.historyId)?.employmentId).toBe(r.employmentId);
  const event=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,batchId),eq(schema.domainEvent.eventType,'payroll-batch.employee-reprocess-outcome')));
  expect(event).toHaveLength(3);expect(event.find(e=>(e.payload as any).employmentId===b.employmentId)?.payload).toMatchObject({jobId:job.id,status:'skipped',payPeriod:'2026-05',reasonCode:'NOTHING_PAYABLE',employeeName:'No payable B',employeeCode:result.outcomes.find(r=>r.employmentId===b.employmentId)!.employeeCode});
  await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[a.employmentId,b.employmentId,c.employmentId],idempotencyKey:key});
  expect((await slip(batchId,a.employmentId)).version).toBe(2);expect((await getReprocessJob(ctx,job.id))?.result).toEqual(result);
 });
 it('all-skipped selection changes no money, headcount, scope or saved payslip',async()=>{
  const b=await hire('Retained');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const old=await batch(batchId),saved=await slip(batchId,b.employmentId);await zero(b);const {result}=await run([b.employmentId],batchId);
  expect(result.skipped).toBe(1);expect(result.reprocessed).toBe(0);expect(await batch(batchId)).toEqual(old);expect(await slip(batchId,b.employmentId)).toEqual(saved);
 });
 it('new no-pay addition rolls collection back and creates no phantom saved result',async()=>{
  const a=await hire('Initially paid');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const b=await hire('New zero',0);const [txn]=await owner.db.insert(schema.payrollIndividualTxn).values({tenantId:base.tenantId,companyId:base.companyId,payPeriod:'2026-05',
   employmentId:b.employmentId,kind:'unpaid',txnDate:'2026-05-12',amount:'20.00'}).returning();
  const {result}=await run([b.employmentId],batchId);expect(result.outcomes[0]).toMatchObject({status:'skipped',resultRetained:false,payslipId:null,historyId:null});
  expect(await slip(batchId,b.employmentId)).toBeUndefined();expect((await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id,txn.id)))[0]).toEqual(txn);
  expect((await batch(batchId)).employeeCount).toBe(1);expect((await slip(batchId,a.employmentId)).version).toBe(1);
 });
 it('missing compensation fails only that employee and never becomes a no-pay skip',async()=>{
  const a=await hire('Paid');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const b=await hireEmployee(ctx,{person:{fullName:'Missing salary',primaryEmail:`${randomUUID()}@r382.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const {result}=await run([a.employmentId,b.employmentId],batchId);expect(result.validationFailed).toBe(1);expect(result.reprocessed).toBe(1);expect(result.skipped).toBe(0);
  expect(result.outcomes.find(r=>r.employmentId===b.employmentId)).toMatchObject({status:'validation_failed',reasonCode:'PAYROLL_CONFIGURATION_INCOMPLETE',validationDetails:[{gap:'no current salary record'}]});
  expect(await slip(batchId,b.employmentId)).toBeUndefined();
 });
 it('no-pay precedes a missing REP declaration, but payable REP validation continues other employees',async()=>{
  const a=await hire('Normal'),b=await hire('REP');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const oldB=await slip(batchId,b.employmentId);
  await owner.db.update(schema.employeeStatutoryMy).set({taxResidency:'rep'}).where(eq(schema.employeeStatutoryMy.personId,b.personId));
  let r=await run([a.employmentId,b.employmentId],batchId);expect(r.result.reprocessed).toBe(1);expect(r.result.validationFailed).toBe(1);
  expect(r.result.outcomes.find(r=>r.employmentId===b.employmentId)).toMatchObject({status:'validation_failed',validationCode:'missing_declaration'});expect(await slip(batchId,b.employmentId)).toEqual(oldB);
  await zero(b);r=await run([b.employmentId],batchId);expect(r.result.skipped).toBe(1);expect(r.result.validationFailed).toBe(0);expect(await slip(batchId,b.employmentId)).toEqual(oldB);
 });
 it('a nonempty earning with final net zero is still reprocessed',async()=>{
  const a=await hire('With earnings');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  await owner.db.insert(schema.payrollInput).values({tenantId:base.tenantId,batchId,employmentId:a.employmentId,zakat:'9000.00'});
  const {result}=await run([a.employmentId],batchId);expect(result.reprocessed).toBe(1);expect(result.skipped).toBe(0);expect(Number((await slip(batchId,a.employmentId)).netPay)).toBe(0);
 });
 it('concurrent disjoint selections serialize totals and exact outcome history',async()=>{
  const a=await hire('First'),b=await hire('Second');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  await owner.db.update(schema.compensation).set({basicSalary:'4000.00'}).where(eq(schema.compensation.employmentId,a.employmentId));
  await owner.db.update(schema.compensation).set({basicSalary:'5000.00'}).where(eq(schema.compensation.employmentId,b.employmentId));
  const results=await Promise.all([run([a.employmentId],batchId),run([b.employmentId],batchId)]);
  expect(Number(((await batch(batchId)).totals as any).gross)).toBe(9000);
  expect(results.map(r=>r.result.outcomes[0].historyId).every(Boolean)).toBe(true);
  expect(new Set(results.map(r=>r.result.outcomes[0].historyId)).size).toBe(2);
 });
 it('job result read refuses an explicitly denied payroll operator without disclosing stored identities',async()=>{
  const a=await hire('Private');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});const {job}=await run([a.employmentId],batchId);
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,companyId:base.companyId,role:'hr_admin',permissionKey:'payroll.reprocess.selective',allowed:false});
  expect(await getReprocessJob(ctx,job.id)).toBeNull();
 });
 it('a full payable wage reduced by unpaid transactions skips before any statutory invocation',async()=>{
  const a=await hire('Entire wage unpaid');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const saved=await slip(batchId,a.employmentId);
  await setSetting(base.tenantId,'payroll.individual_txn_pay_enabled',true);ctx=await entitledCtx(base);
  // A period wage reduction is different from a post-statutory deduction: cash earnings are absent.
  await owner.db.insert(schema.payrollIndividualTxn).values({tenantId:base.tenantId,batchId,companyId:base.companyId,payPeriod:'2026-05',
   employmentId:a.employmentId,kind:'unpaid',txnDate:'2026-05-12',amount:'3000.00'});
  const statutory=vi.spyOn(packFor('MY')!.payroll,'statutory');
  try {const {result}=await run([a.employmentId],batchId);expect(result.skipped).toBe(1);expect(statutory).not.toHaveBeenCalled();expect(await slip(batchId,a.employmentId)).toEqual(saved);}
  finally {statutory.mockRestore();}
 });
 it('global failure retains an atomic checkpoint and stale-job retry never bumps the completed employee twice',async()=>{
  const a=await hire('First'),b=await hire('Second');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const selected=[a.employmentId,b.employmentId].sort(),key=randomUUID();
  const pack=packFor('MY')!;const original=pack.payroll.statutory;let calls=0;
  const probe=vi.spyOn(pack.payroll,'statutory').mockImplementation((...args)=>{if(++calls>1)throw new Error('private database SQL failure');return original(...args);});
  let stopped:PayrollReprocessStoppedError|undefined;
  try {await reprocessSelectedEmployees(ctx,{batchId,employmentIds:selected,idempotencyKey:key});}
  catch(error){expect(error).toBeInstanceOf(PayrollReprocessStoppedError);stopped=error as PayrollReprocessStoppedError;expect((stopped.cause as Error).message).toContain('private database');}
  finally {probe.mockRestore();}
  expect(stopped).toBeDefined();const [job]=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.id,stopped!.jobId));
  expect(job.error).toBe('REPROCESS_STOPPED');expect((job.result as ReprocessJobResult).outcomes).toHaveLength(1);
  expect((await slip(batchId,selected[0])).version).toBe(2);expect((await slip(batchId,selected[1])).version).toBe(1);
  // Emulate an abandoned lease after a process exits between employee transactions, without erasing its checkpoint.
  await owner.db.update(schema.payrollReprocessJob).set({status:'running',updatedAt:new Date(Date.now()-11*60*1000)}).where(eq(schema.payrollReprocessJob.id,job.id));
  await reprocessSelectedEmployees(ctx,{batchId,employmentIds:selected,idempotencyKey:key});
  expect((await slip(batchId,selected[0])).version).toBe(2);expect((await slip(batchId,selected[1])).version).toBe(2);
  expect((await getReprocessJob(ctx,job.id))?.result).toMatchObject({reprocessed:2,outcomes:expect.any(Array)});
 });
 it('latest outcomes use attempt instants and explicit links, rejecting forged success and cross-selection rows',async()=>{
  const a=await hire('Latest');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const first=await run([a.employmentId],batchId);await zero(a);const second=await run([a.employmentId],batchId);
  await owner.db.update(schema.payrollReprocessJob).set({updatedAt:new Date(Date.now()+60000)}).where(eq(schema.payrollReprocessJob.id,first.job.id));
  expect(await listReprocessEmployeeOutcomes(ctx,{batchId})).toMatchObject([{jobId:second.job.id,status:'skipped',resultRetained:true,versionAfter:2}]);
  expect(await listReprocessEmployeeOutcomes(ctx,{batchIds:[batchId,batchId,base.companyId]})).toMatchObject([{batchId,jobId:second.job.id,status:'skipped',resultRetained:true,versionAfter:2}]);
  const row=first.result.outcomes[0];expect(decodeReprocessEmployeeOutcomes({outcomes:[{...row,historyId:null}]},[a.employmentId])).toBeNull();
  expect(decodeReprocessEmployeeOutcomes({outcomes:[row]},[randomUUID()])).toBeNull();
  expect(decodeReprocessEmployeeOutcomes({outcomes:[{...row,effectiveTaxScheme:'invented'}]},[a.employmentId])).toBeNull();
  expect(decodeReprocessEmployeeOutcomes({outcomes:[row,row]},[a.employmentId])).toBeNull();
 });

 it('entire-month unpaid leave with a positive monthly salary is no payable earnings, not a missing salary',async()=>{
  const a=await hire('Entire unpaid month');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});const before=await slip(batchId,a.employmentId);
  await owner.db.insert(schema.leaveRequest).values({tenantId:base.tenantId,employmentId:a.employmentId,leaveTypeId:base.annualLeaveTypeId,
    startDate:'2026-05-01',endDate:'2026-05-31',days:'31.00',unpaidDays:'31.00',status:'approved'});
  const statutory=vi.spyOn(packFor('MY')!.payroll,'statutory');
  try {const {result}=await run([a.employmentId],batchId);expect(result.skipped).toBe(1);expect(result.validationFailed).toBe(0);expect(statutory).not.toHaveBeenCalled();expect(await slip(batchId,a.employmentId)).toEqual(before);}
  finally {statutory.mockRestore();}
 });
 it('an HR role scoped elsewhere cannot read the whole job through their own visible payslip',async()=>{
  const a=await hire('Own payslip'),b=await hire('Private coworker');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});const {job}=await run([a.employmentId,b.employmentId],batchId);
  const ownUser=await createAppUser(base.tenantId,a.personId,'employee');
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Other employer'}).returning();
  const caller={...ctx,userId:ownUser,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:other.id}]};
  expect(await getReprocessJob(caller,job.id)).toBeNull();expect(await listReprocessEmployeeOutcomes(caller,{batchId})).toEqual([]);expect(await listReprocessEmployeeOutcomes(caller,{batchIds:[batchId,base.companyId]})).toEqual([]);
 });

 it('overlapping selections each record their own exact serial result rather than borrowing another job history',async()=>{
  const a=await hire('Same employee');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const pair=await Promise.all([run([a.employmentId],batchId),run([a.employmentId],batchId)]);
  expect((await slip(batchId,a.employmentId)).version).toBe(3);
  expect(pair.map(r=>r.result.outcomes[0].versionAfter).sort()).toEqual([2,3]);
  expect(new Set(pair.map(r=>r.result.outcomes[0].historyId)).size).toBe(2);
  for(const r of pair){const [h]=await owner.db.select().from(schema.payrollEmployeeResultHistory).where(eq(schema.payrollEmployeeResultHistory.id,r.result.outcomes[0].historyId!));expect(h.versionAfter).toBe(r.result.outcomes[0].versionAfter);}
 });

 it('a live obsolete worker cannot overwrite a reclaimed running or completed job as failed',async()=>{
  const a=await hire('Lease A'),b=await hire('Lease B'),c=await hire('Lease C');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});
  const selected=[a.employmentId,b.employmentId,c.employmentId].sort(),key=randomUUID();
  let reachedA!:()=>void,releaseA!:()=>void,reachedB!:()=>void,releaseB!:()=>void,pausedA=false,pausedB=false;
  const reachedAPromise=new Promise<void>(r=>{reachedA=r;});const releaseAPromise=new Promise<void>(r=>{releaseA=r;});
  const reachedBPromise=new Promise<void>(r=>{reachedB=r;});const releaseBPromise=new Promise<void>(r=>{releaseB=r;});
  const original=payrollGate.withPayrollTenant;const hook=vi.spyOn(payrollGate,'withPayrollTenant');
  hook.mockImplementation((async(...args:Parameters<typeof original>)=>{
   const value=await original(...args);
   if(value===undefined){
    const [job]=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey,key));
    const count=(job?.result as ReprocessJobResult)?.outcomes?.length;
    if(job?.status==='running' && count===1 && !pausedA){pausedA=true;reachedA();await releaseAPromise;}
    else if(job?.status==='running' && count===2 && pausedA && !pausedB){pausedB=true;reachedB();await releaseBPromise;}
   }
   return value;
  }) as typeof original);
  const obsolete=reprocessSelectedEmployees(ctx,{batchId,employmentIds:selected,idempotencyKey:key}).catch(error=>error);
  let recovered:Promise<unknown>|undefined;
  try {
   await reachedAPromise;
   await owner.db.update(schema.payrollReprocessJob).set({updatedAt:new Date(Date.now()-11*60*1000)}).where(eq(schema.payrollReprocessJob.idempotencyKey,key));
   recovered=reprocessSelectedEmployees(ctx,{batchId,employmentIds:selected,idempotencyKey:key}).catch(error=>error);
   await reachedBPromise;
   const [beforeLate]=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey,key));expect(beforeLate.status).toBe('running');
   releaseA();expect(await obsolete).toBeInstanceOf(PayrollReprocessStoppedError);
   const [afterLate]=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey,key));
   expect(afterLate).toEqual(beforeLate);expect(afterLate.status).toBe('running');
   releaseB();expect(await recovered).toMatchObject({status:'completed'});
   const [done]=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey,key));expect(done.status).toBe('completed');expect(done.error).toBeNull();
   for(const id of selected)expect((await slip(batchId,id)).version).toBe(2);
  } finally {releaseA();releaseB();await obsolete;await recovered;hook.mockRestore();}
 });
 it('a selected existing member whose salary was removed gets an employee validation and retains the exact saved result',async()=>{
  const a=await hire('Ready'),b=await hire('Salary removed');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-05'});await generatePayslips(ctx,{batchId});const before=await slip(batchId,b.employmentId);
  await owner.db.delete(schema.compensation).where(eq(schema.compensation.employmentId,b.employmentId));
  const {result}=await run([a.employmentId,b.employmentId],batchId);expect(result.reprocessed).toBe(1);expect(result.validationFailed).toBe(1);
  expect(result.outcomes.find(o=>o.employmentId===b.employmentId)).toMatchObject({status:'validation_failed',reasonCode:'PAYROLL_CONFIGURATION_INCOMPLETE',resultRetained:true,versionAfter:before.version});
  expect(await slip(batchId,b.employmentId)).toEqual(before);
 });

});
