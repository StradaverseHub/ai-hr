import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createCompany,createDepartment} from '../core/admin';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {createBatch,generatePayslips,batchDetail,resetProcessedBatch,deleteDraftBatch,closeBatch,myPayslipDetail} from '../core/payroll';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {nativePayrollPayslip,nativePayrollPayslipWrite,nativeHistoryBaselineSourcesTx,finalizeNativeHistoryBaselinesTx} from '../core/payroll-history-native-baseline';
import {requestPayrollHistoryConfirm,payrollHistoryJobHandler} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';

let b:Base,ctx:SessionContext,employee:SessionContext,employmentId:string,personId:string,batchId:string;
const year=Number(todayInKualaLumpur().slice(0,4))-2,period=`${year}-01`;
const physical=()=>withTenant(ctx,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.batchId,batchId)));
const effective=()=>withTenant(ctx,tx=>tx.select().from(s.payslip).where(eq(s.payslip.employmentId,employmentId)));
async function correction(amount='6000.00'){
 const rows=[['N001',period,'ME','BASIC','NATIVE',amount],...['EEEPF','EESOCSO','EEEIS','PCB'].map(code=>['N001',period,'ME',code,'NATIVE','0.00'])];
 const preview=await previewPayrollHistoryUpload(ctx,{name:'fictional-native-history.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows])),maintenance:{version:1,mode:'replace',reason:'Correct fictional retained native figures'}});
 expect(preview.plan.counts.invalid,JSON.stringify(preview.plan)).toBe(0);
 return {preview,commit:()=>confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true})};
}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setSetting(b.tenantId,'payroll.reset_enabled',true);ctx=await entitledCtx(b);
 await owner.db.update(s.company).set({companyLabel:'NATIVE'}).where(eq(s.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
 const hire=await hireEmployee(ctx,{person:{fullName:'Fictional mutable native employee',primaryEmail:'native@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'N001',hiredOn:`${year-1}-01-01`});employmentId=hire.employmentId;personId=hire.personId;
 await setCompensation(ctx,{employmentId,basicSalary:4000,effectiveFrom:`${year-1}-01-01`});await setStatutoryProfileMY(ctx,{personId,icNumber:'850202025555',taxCategory:1,numChildren:0});
 const userId=await createAppUser(b.tenantId,personId,'employee');employee={...await entitledCtx(b,['employee']),userId,personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await generatePayslips(ctx,{batchId});
});
afterAll(closeAll);
describe('detached history baseline and mutable native payroll owner',()=>{
 it('keeps a native run visible, resets and regenerates it, deletes the whole native batch, and restores the exact detached baseline',async()=>{
  const [original]=await physical();expect(original).toBeTruthy();const edit=await correction();await edit.commit();
  const [baseline]=await owner.db.select().from(s.payrollHistoryImportRevision).where(and(eq(s.payrollHistoryImportRevision.kind,'adopted'),eq(s.payrollHistoryImportRevision.attemptId,edit.preview.attemptId)));
  expect(baseline.nativeSource).toMatchObject({sourceBatchId:batchId,sourcePayslipId:original.id,sourceVersion:original.version});expect(baseline.snapshotId).not.toBe(original.id);
  const [retained]=await owner.db.select().from(s.payslip).where(eq(s.payslip.id,baseline.snapshotId!));expect(retained).toMatchObject({basicSalary:original.basicSalary,grossPay:original.grossPay,statutory:original.statutory});
  expect((await effective()).map(p=>p.grossPay)).toEqual(['6000.00']);expect((await physical()).map(p=>p.id)).toEqual([original.id]);expect((await batchDetail(ctx,batchId))?.slips).toHaveLength(1);
  expect(await resetProcessedBatch(ctx,{batchId,reason:'Review corrected native run'})).toMatchObject({payslipsCleared:1});expect(await physical()).toEqual([]);expect((await effective()).map(p=>p.grossPay)).toEqual(['6000.00']);
  await generatePayslips(ctx,{batchId});expect(await physical()).toHaveLength(1);expect((await effective()).map(p=>p.grossPay)).toEqual(['6000.00']);
  await resetProcessedBatch(ctx,{batchId,reason:'Delete the original native draft'});await deleteDraftBatch(ctx,{batchId});expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).toEqual([]);
  const review=await previewPayrollHistoryRevert(ctx,edit.preview.attemptId);await revertPayrollHistoryUpload(ctx,edit.preview.attemptId,review.previewHash);
  expect((await effective()).map(p=>[p.id,p.grossPay])).toEqual([[retained.id,original.grossPay]]);expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,retained.id)))[0]).toEqual(retained);
 });
 it('does not suppress a new unrelated native batch for the same employment and month',async()=>{
  await(await correction()).commit();await resetProcessedBatch(ctx,{batchId,reason:'Replace the original native run'});await deleteDraftBatch(ctx,{batchId});
  const later=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;expect(later).not.toBe(batchId);await generatePayslips(ctx,{batchId:later});
  expect((await effective()).map(p=>p.grossPay).sort()).toEqual(['4000.00','6000.00']);
 });
 it('refuses a stale reviewed native source without publishing a baseline or correction',async()=>{
  const [original]=await physical(),edit=await correction();await withTenant(ctx,tx=>tx.update(nativePayrollPayslipWrite).set({version:original.version+1}).where(eq(nativePayrollPayslipWrite.id,original.id)));
  await expect(edit.commit()).rejects.toThrow(/changed|preview|review/i);expect(await owner.db.select().from(s.payrollHistoryImportRevision)).toEqual([]);expect(await owner.db.select().from(s.payrollHistoryImportSnapshot)).toEqual([]);expect((await physical())[0].version).toBe(original.version+1);
 });
 it('keeps the final checked source locked through transaction commit against a direct app write',async()=>{
  const [original]=await physical(),edit=await correction();await edit.commit();let release!:()=>void,locked!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;});
  const finalizing=withTenant(ctx,async tx=>{await finalizeNativeHistoryBaselinesTx(tx,ctx,edit.preview.attemptId);locked();await held;});
  try{await Promise.race([ready,finalizing]);await expect(withTenant(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='200ms'`);return tx.update(nativePayrollPayslipWrite).set({version:original.version+1}).where(eq(nativePayrollPayslipWrite.id,original.id));})).rejects.toMatchObject({cause:{code:'55P03'}});}finally{release();await finalizing;}
  expect((await physical())[0]).toEqual(original);
 });
 it('keeps original issued bytes after the native batch closes and refuses both owner-view mutation and the ordinary closed adoption mutation',async()=>{
  const [original]=await physical();await(await correction()).commit();
  // Maintenance marks the native result stale. Its canonical reset/reprocess is the only path to Close.
  await resetProcessedBatch(ctx,{batchId,reason:'Reprocess after reviewed history correction'});await generatePayslips(ctx,{batchId});const [issued]=await physical();await closeBatch(ctx,{batchId});
  expect((await myPayslipDetail(employee,issued.id))?.basic).toBe(issued.basicSalary);expect((await physical()).map(p=>p.id)).toEqual([issued.id]);
  expect(await withTenant(ctx,tx=>tx.update(nativePayrollPayslipWrite).set({grossPay:'1.00'}).where(eq(nativePayrollPayslipWrite.id,issued.id)).returning())).toEqual([]);
  await expect(owner.db.update(s.payslip).set({grossPay:'1.00'}).where(eq(s.payslip.id,issued.id))).rejects.toThrow();
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,issued.id)))[0]).toEqual(issued);expect(issued.grossPay).toBe(original.grossPay);
 });
 it('denies manager and department-head pay reads even where identity visibility allows the subordinate',async()=>{
  const [original]=await physical();expect(await withTenant(employee,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,original.id)))).toHaveLength(1);
  for(const kind of ['manager','head'] as const){
   const hire=await hireEmployee(ctx,{person:{fullName:'Fictional '+kind,primaryEmail:kind+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
   if(kind==='manager')await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:employmentId,managerEmploymentId:hire.employmentId,lineType:'administrative',validFrom:`${year-1}-01-01`});
   else{const report=await hireEmployee(ctx,{person:{fullName:'Fictional head report',primaryEmail:'head-report@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:report.employmentId,managerEmploymentId:hire.employmentId,lineType:'administrative',validFrom:`${year-1}-01-01`});await owner.db.update(s.department).set({headEmploymentId:hire.employmentId}).where(eq(s.department.id,b.deptA));}
   const userId=await createAppUser(b.tenantId,hire.personId,'manager'),as:SessionContext={...await entitledCtx(b,['manager']),userId,personId:hire.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]};
   expect((await withTenant(as,tx=>tx.execute<{visible:boolean}>(sql`select app.can_see_employment(${employmentId}::uuid) visible`)))[0].visible).toBe(true);
   expect(await withTenant(as,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,original.id)))).toEqual([]);
   expect(await withTenant(as,tx=>tx.update(nativePayrollPayslipWrite).set({grossPay:'1.00'}).where(eq(nativePayrollPayslipWrite.id,original.id)).returning())).toEqual([]);
  }
 });
 it('never exposes unreleased copy rows through either view even with a forged stage GUC',async()=>{
  const edit=await correction(),oldBudget=process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const job=await requestPayrollHistoryConfirm(ctx,{attemptId:edit.preview.attemptId,previewHash:edit.preview.plan.previewHash,confirmReplacement:true});if(!('jobId' in job))throw Error('Expected a staged native fixture');let stagedId:string|undefined;
   for(let n=0;n<50;n++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const rows=await owner.client<{row_id:string}[]>`select row_id from app.payroll_history_staged_row where stage_id=${job.jobId}::uuid and relation='payslip' limit 1`;if(rows.length){stagedId=rows[0].row_id;break;}}
   expect(stagedId).toBeTruthy();
   await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_history_stage',${job.jobId},true)`);expect(await tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,stagedId!))).toEqual([]);expect(await tx.select().from(nativePayrollPayslipWrite).where(eq(nativePayrollPayslipWrite.id,stagedId!))).toEqual([]);expect((await tx.execute<{ok:boolean}>(sql`select app.payroll_history_native_baseline(${stagedId}::uuid) ok`))[0].ok).toBe(false);});
  }finally{if(oldBudget===undefined)delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;else process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS=oldBudget;}
 });
 it('keeps same-tenant company scope on SELECT, DELETE, INSERT and UPDATE row moves',async()=>{
  const [original]=await physical(),company=await createCompany(ctx,{legalName:'Fictional other native company',companyLabel:'OTHER-NATIVE',country:'MY',currency:'MYR'}),dept=await createDepartment(ctx,{companyId:company.id,name:'Fictional other department'});
  const hire=await hireEmployee(ctx,{person:{fullName:'Fictional other native employee',primaryEmail:'other-native@fixture.invalid'},companyId:company.id,departmentId:dept.id,employmentType:'full_time',hiredOn:`${year-1}-01-01`});await setCompensation(ctx,{employmentId:hire.employmentId,basicSalary:3000,effectiveFrom:`${year-1}-01-01`});await setStatutoryProfileMY(ctx,{personId:hire.personId,icNumber:'850303035555'});const otherBatch=(await createBatch(ctx,{companyId:company.id,payPeriod:period})).batchId;await generatePayslips(ctx,{batchId:otherBatch});
  const [otherSlip]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,otherBatch));await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(and(eq(s.roleAssignment.appUserId,ctx.userId!),eq(s.roleAssignment.role,'hr_admin')));
  const scoped:SessionContext={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:b.companyId}]};
  expect(await withTenant(scoped,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,original.id)))).toHaveLength(1);
  expect(await withTenant(scoped,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,otherSlip.id)))).toEqual([]);expect(await withTenant(scoped,tx=>tx.delete(nativePayrollPayslipWrite).where(eq(nativePayrollPayslipWrite.id,otherSlip.id)).returning())).toEqual([]);
  await expect(withTenant(scoped,tx=>tx.insert(nativePayrollPayslipWrite).values({...otherSlip,id:randomUUID()}))).rejects.toThrow();
  await expect(withTenant(scoped,tx=>tx.update(nativePayrollPayslipWrite).set({batchId:otherBatch}).where(eq(nativePayrollPayslipWrite.id,original.id)))).rejects.toThrow();
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,original.id)))[0]).toEqual(original);
 });
 it('enforces app principal, tenant, employment and module scope on direct read/write views, including attempted row moves',async()=>{
  const [original]=await physical();await(await correction()).commit();
  expect(await withTenant(employee,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,original.id)))).toEqual([]);
  expect(await withTenant(employee,tx=>tx.delete(nativePayrollPayslipWrite).where(eq(nativePayrollPayslipWrite.id,original.id)).returning())).toEqual([]);
  const other=await seedBase();await setModule(other.tenantId,'payroll','active');const outsider=await entitledCtx(other);
  expect(await withTenant(outsider,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,original.id)))).toEqual([]);
  expect(await withTenant(outsider,tx=>tx.delete(nativePayrollPayslipWrite).where(eq(nativePayrollPayslipWrite.id,original.id)).returning())).toEqual([]);
  await expect(withTenant(ctx,tx=>tx.update(nativePayrollPayslipWrite).set({tenantId:other.tenantId}).where(eq(nativePayrollPayslipWrite.id,original.id)))).rejects.toThrow();
  await expect(withTenant(outsider,tx=>tx.insert(nativePayrollPayslipWrite).values({...original,id:randomUUID()}))).rejects.toThrow();
  const sources=await withTenant(ctx,tx=>nativeHistoryBaselineSourcesTx(tx,ctx,[original.id]));expect(sources).toMatchObject([{sourcePayslipId:original.id,sourceVersion:original.version}]);expect(await withTenant(outsider,tx=>nativeHistoryBaselineSourcesTx(tx,outsider,[original.id]))).toEqual([]);
  await setModule(b.tenantId,'payroll','disabled');expect(await withTenant(ctx,tx=>tx.select().from(nativePayrollPayslip))).toEqual([]);expect(await withTenant(ctx,tx=>tx.delete(nativePayrollPayslipWrite).where(eq(nativePayrollPayslipWrite.id,original.id)).returning())).toEqual([]);
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,original.id)))[0]).toEqual(original);
 });
});
