import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createCompany,createDepartment} from '../core/admin';
import {hireEmployee} from '../core/org';
import {upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {readEffectiveTaxBasesTx,taxBasisSourceRowsTx} from '../core/payroll-tax-basis-read';
import {readPcbNonCash} from '../localization/noncash-benefits';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {createBatch,generatePayslips,batchDetail,resetProcessedBatch,deleteDraftBatch,closeBatch,myPayslipDetail} from '../core/payroll';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {nativePayrollPayslip,nativePayrollPayslipWrite,nativeHistoryBaselineSourcesTx,finalizeNativeHistoryBaselinesTx,type DetachedNativeHistoryBaseline} from '../core/payroll-history-native-baseline';
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
 it('restores generated recurring BIK and VOLA as native owned evidence and consumes it exactly once in the next month',async()=>{
  await setModule(b.tenantId,'typed_pay_components','active');ctx=await entitledCtx(b);await resetProcessedBatch(ctx,{batchId,reason:'Add fictional native recurring benefits'});
  const flags={kind:'non_payable' as const,isNonPayable:true,prorates:false,includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'normal' as const,pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:false};
  const bik=await upsertPayComponent(ctx,{...flags,code:'NATIVE_CAR',label:'Fictional recurring car',name:'Fictional recurring car',displayCategory:'bik',eaFormLine:'EA_B3'}),vola=await upsertPayComponent(ctx,{...flags,code:'NATIVE_HOME',label:'Fictional recurring home',name:'Fictional recurring home',displayCategory:'vola',eaFormLine:'EA_B4'});
  await setEmploymentPayComponent(ctx,{employmentId,componentId:bik.id,amount:600,effectiveFrom:`${year-1}-01-01`});await setEmploymentPayComponent(ctx,{employmentId,componentId:vola.id,amount:900,effectiveFrom:`${year-1}-01-01`});await generatePayslips(ctx,{batchId});
  const [original]=await physical(),noncash=readPcbNonCash((original.statutory as {pcbNonCash:unknown}).pcbNonCash);expect(noncash).not.toBeNull();expect(noncash!.owned).toEqual({bik:600,vola:900});expect(noncash!.ownedEaEntries).toEqual(expect.arrayContaining([expect.objectContaining({code:'NATIVE_CAR',source:'recurring',reportableAmount:600}),expect.objectContaining({code:'NATIVE_HOME',source:'recurring',reportableAmount:900})]));
  const edit=await correction();await edit.commit();expect((await effective()).map(row=>row.grossPay)).toEqual(['6000.00']);const review=await previewPayrollHistoryRevert(ctx,edit.preview.attemptId);await revertPayrollHistoryUpload(ctx,edit.preview.attemptId,review.previewHash);
  const [restored]=await effective();expect(restored.id).not.toBe(original.id);expect(restored.statutory).toEqual(original.statutory);expect(readPcbNonCash((restored.statutory as {pcbNonCash:unknown}).pcbNonCash)).toEqual(noncash);
  const sources=await withTenant(ctx,tx=>taxBasisSourceRowsTx(tx,[restored.id]));expect(sources).toHaveLength(1);expect(sources[0].historyAttemptId).toBeNull();expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[restored.id],{includeImported:true}))).size).toBe(0);
  const nextPeriod=`${year}-02`,nextBatch=(await createBatch(ctx,{companyId:b.companyId,payPeriod:nextPeriod})).batchId;await generatePayslips(ctx,{batchId:nextBatch});const [next]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,nextBatch)),nextNoncash=readPcbNonCash((next.statutory as {pcbNonCash:unknown}).pcbNonCash);
  expect(nextNoncash).not.toBeNull();expect(nextNoncash!.accumulated).toMatchObject({bik:600,vola:900,complete:true});expect(nextNoncash!.owned).toEqual({bik:600,vola:900});expect((await effective()).map(row=>row.id).sort()).toEqual([restored.id,next.id].sort());
  // Damaged ownership remains unknown to the existing strict reader, never a fabricated zero source.
  expect(readPcbNonCash({...noncash,ownedEaEntries:[]})).toBeNull();
 });
 it('requires the held discard capability to delete private pending baseline proof, including after creator access is revoked',async()=>{
  const [original]=await physical(),edit=await correction(),oldBudget=process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const job=await requestPayrollHistoryConfirm(ctx,{attemptId:edit.preview.attemptId,previewHash:edit.preview.plan.previewHash,confirmReplacement:true});if(!('jobId' in job))throw Error('Expected staged native baseline');let snapshotId:string|undefined;
   for(let n=0;n<100;n++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const rows=await owner.client<{snapshot_id:string}[]>`select snapshot_id from app.payroll_history_native_capture where attempt_id=${edit.preview.attemptId}::uuid`;if(rows.length){snapshotId=rows[0].snapshot_id;break;}}
   expect(snapshotId).toBeTruthy();await expect(owner.client`delete from app.payroll_history_native_capture where snapshot_id=${snapshotId!}::uuid`).rejects.toMatchObject({code:'42501',message:'bulk_job_lease_required'});await expect(owner.client`update app.payroll_history_native_capture set source_hash=${'0'.repeat(64)} where snapshot_id=${snapshotId!}::uuid`).rejects.toMatchObject({code:'42501',message:'Native history capture evidence is immutable'});
   await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.history.import',role:'hr_admin',allowed:false});
   for(let n=0;n<100;n++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const [state]=await owner.client<{state:string}[]>`select state from public.bulk_job where id=${job.jobId}::uuid`;if(state.state==='failed'||state.state==='cancelled')break;}
   expect((await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${job.jobId}::uuid`)[0].state).toBe('discarded');expect(await owner.client`select snapshot_id from app.payroll_history_native_capture where attempt_id=${edit.preview.attemptId}::uuid`).toHaveLength(0);expect(await owner.client`select * from app.payroll_history_staged_row where stage_id=${job.jobId}::uuid`).toHaveLength(0);expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,original.id)))[0]).toEqual(original);
  }finally{if(oldBudget===undefined)delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;else process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS=oldBudget;}
 });
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
 it('refuses caller-forged baseline value commitments or cycle labels even on a valid capture replay',async()=>{
  const edit=await correction();await edit.commit();const [adopted]=await owner.db.select().from(s.payrollHistoryImportRevision).where(and(eq(s.payrollHistoryImportRevision.attemptId,edit.preview.attemptId),eq(s.payrollHistoryImportRevision.kind,'adopted'))),descriptor=(edit.preview.plan.rows[0] as unknown as {detachedNativeBaseline:DetachedNativeHistoryBaseline}).detachedNativeBaseline;
  expect(descriptor.valueHash).toMatch(/^[a-f0-9]{64}$/);
  const replay=(cycle:string,valueHash:string)=>withTenant(ctx,tx=>tx.execute(sql`select app.payroll_history_capture_native(${edit.preview.attemptId}::uuid,${adopted.recordId}::uuid,${JSON.stringify(descriptor)}::jsonb,${cycle},${valueHash})`));
  await expect(replay('Caller forged cycle',descriptor.valueHash)).rejects.toThrow();await expect(replay(edit.preview.plan.rows[0].cycleName,'0'.repeat(64))).rejects.toThrow();
  expect((await effective()).map(p=>p.grossPay)).toEqual(['6000.00']);
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
 it('publishes the exact staged native baseline through the real worker while forged stage IDs never expose its drafts',async()=>{
  const [original]=await physical();const edit=await correction(),oldBudget=process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const job=await requestPayrollHistoryConfirm(ctx,{attemptId:edit.preview.attemptId,previewHash:edit.preview.plan.previewHash,confirmReplacement:true});if(!('jobId' in job))throw Error('Expected a staged native fixture');let stagedId:string|undefined;
   for(let n=0;n<50;n++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const rows=await owner.client<{row_id:string}[]>`select row_id from app.payroll_history_staged_row where stage_id=${job.jobId}::uuid and relation='payslip' limit 1`;if(rows.length){stagedId=rows[0].row_id;break;}}
   expect(stagedId).toBeTruthy();
   await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_history_stage',${job.jobId},true)`);expect(await tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,stagedId!))).toEqual([]);expect(await tx.select().from(nativePayrollPayslipWrite).where(eq(nativePayrollPayslipWrite.id,stagedId!))).toEqual([]);expect((await tx.execute<{ok:boolean}>(sql`select app.payroll_history_native_baseline(${stagedId}::uuid) ok`))[0].ok).toBe(false);});
   const descriptor=edit.preview.plan.rows[0].detachedNativeBaseline!;expect(descriptor).toBeTruthy();
   const [copy]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,descriptor.batchId));
   expect(copy).toMatchObject({historyImportAttemptId:edit.preview.attemptId,status:'draft',companyId:b.companyId,payPeriod:period});
   const [captured]=await owner.client<{attempt_id:string;source_batch_id:string;source_payslip_id:string;source_hash:string;baseline_batch_id:string;snapshot_id:string}[]>`select attempt_id,source_batch_id,source_payslip_id,source_hash,baseline_batch_id,snapshot_id from app.payroll_history_native_capture where snapshot_id=${descriptor.snapshotId}::uuid`;
   expect(captured).toMatchObject({attempt_id:edit.preview.attemptId,source_batch_id:batchId,source_payslip_id:original.id,source_hash:descriptor.sourceHash,baseline_batch_id:descriptor.batchId,snapshot_id:descriptor.snapshotId});
   for(let n=0;n<100;n++){
    await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});
    const [state]=await owner.client<{state:string;error:string|null}[]>`select state,error from public.bulk_job where id=${job.jobId}::uuid`;
    if(state.state==='completed')break;if(state.state==='failed'||state.state==='discarding')throw Error(state.error??'Staged native capture refused');
   }
   const [finished]=await owner.client<{state:string}[]>`select state from public.bulk_job where id=${job.jobId}::uuid`;expect(finished.state).toBe('completed');
   const [stage]=await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${job.jobId}::uuid`;expect(stage.state).toBe('released');
   const [adopted]=await owner.db.select().from(s.payrollHistoryImportRevision).where(and(eq(s.payrollHistoryImportRevision.attemptId,edit.preview.attemptId),eq(s.payrollHistoryImportRevision.kind,'adopted')));
   expect(adopted).toMatchObject({snapshotId:descriptor.snapshotId,nativeSource:{sourceBatchId:batchId,sourcePayslipId:original.id,sourceHash:descriptor.sourceHash,baselineBatchId:descriptor.batchId,baselineSnapshotId:descriptor.snapshotId}});
   expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,descriptor.batchId)))[0]).toMatchObject({historyImportAttemptId:edit.preview.attemptId,status:'closed'});
   expect((await physical())[0]).toEqual(original);expect((await effective()).map(p=>p.grossPay)).toEqual(['6000.00']);

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
