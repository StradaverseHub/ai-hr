import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,changeEmploymentCompany} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,createAdditionalRun,generatePayslips,saveStatutoryAdjustment} from '../core/payroll';
import {seedPayComponentCatalog,setPayrollBatchComponent} from '../core/pay-components';
import {multiCycleWorksheetMY} from '../localization/my/multicycle-worksheet';
import {crossEmployerPcbExposure} from '../localization/my/reports';
import {getTaxSelectionMY,resolveTaxSelectionMY,saveTaxSelectionMY} from '../localization/my/tax-selection';
import {setStatutoryProfileMY,setTaxProfileMY} from '../localization/my/statutory';
import {explainPcb,pcbTaxCategoryIdentity} from '../core/pcb-explain';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,entitledCtx,setModule,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,e:Awaited<ReturnType<typeof hireEmployee>>;
const period=todayInKualaLumpur().slice(0,7),hiredOn=`${period.slice(0,4)}-01-01`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();e=await hireEmployee(adminCtx(b),{person:{fullName:'Synthetic circumstance',primaryEmail:`circ_${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});await setStatutoryProfileMY(adminCtx(b),{personId:e.personId,icNumber:'900101017654',taxCategory:3});await setCompensation(adminCtx(b),{employmentId:e.employmentId,basicSalary:8000,monthlyAllowance:0,effectiveFrom:hiredOn});});
const profile=async()=>{const [row]=await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId));return row;};
const resolve=(employmentId=e.employmentId,companyId=b.companyId)=>withTenant(adminCtx(b),tx=>resolveTaxSelectionMY(tx,{tenantId:b.tenantId,employmentId,companyId,payPeriod:period}));
const select=async(key:string,scheme:string)=>{const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);return setTaxProfileMY(adminCtx(b),{personId:e.personId,employmentId:e.employmentId,expectedCompanyId:b.companyId,expectedSelectionVersion:view.version,expectedApplicabilityEpoch:view.taxApplicabilityEpoch,taxCategory:(await profile()).taxCategory,taxCircumstance:key,taxResidency:scheme});};
const slip=async(batchId:string)=>{const [row]=await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,batchId),eq(schema.payslip.employmentId,e.employmentId)));expect(row).toBeTruthy();return row;};
describe('r385 authoritative tax circumstance transactions',()=>{
 it('widow choice survives save and detailed label changes preserve epoch and Category3',async()=>{
  await select('widow_divorced','resident');expect(await profile()).toMatchObject({taxCategory:3,taxCircumstance:'widow_divorced',taxApplicabilityEpoch:0});
  await select('spouse_working','resident');expect(await profile()).toMatchObject({taxCategory:3,taxCircumstance:'spouse_working',taxApplicabilityEpoch:0});
 });
 it('explicit None bypasses missing selection without guessing a taxable legacy record',async()=>{
  expect(await resolve()).toMatchObject({scheme:'resident',taxCircumstance:{applicable:true,key:null,category:3}});
  await select('none','none');await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  expect(await resolve()).toMatchObject({scheme:'none',taxCircumstance:{applicable:false,key:'none',category:null,epoch:1}});
 });
 it('None keeps other employer scheme history; returning taxable cannot resurrect its old incentive',async()=>{
  const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic second employer'}).returning();
  const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Synthetic department'}).returning();
  const other=await hireEmployee(adminCtx(b),{person:{id:e.personId},companyId:company.id,departmentId:dept.id,employmentType:'full_time',hiredOn});
  await saveTaxSelectionMY(adminCtx(b),{employmentId:other.employmentId,expectedCompanyId:company.id,scheme:'rep'});
  const before=await owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,other.employmentId)).orderBy(schema.employmentTaxSelectionMy.id);
  await select('none','none');expect(await resolve(other.employmentId,company.id)).toMatchObject({scheme:'none'});
  await select('widow_divorced','resident');expect(await resolve()).toMatchObject({scheme:'resident',taxCircumstance:{epoch:2}});
  await expect(resolve(other.employmentId,company.id)).rejects.toMatchObject({code:'confirmation_required'});
  expect(await owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,other.employmentId)).orderBy(schema.employmentTaxSelectionMy.id)).toEqual(before);
 });
 it('stale applicability and forged None plus incentive roll back person and employer changes',async()=>{
  const before=await profile();const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);
  await expect(setTaxProfileMY(adminCtx(b),{personId:e.personId,employmentId:e.employmentId,expectedCompanyId:b.companyId,expectedSelectionVersion:view.version,expectedApplicabilityEpoch:view.taxApplicabilityEpoch,taxCircumstance:'none',taxResidency:'rep'})).rejects.toMatchObject({code:'invalid_scheme'});
  expect(await profile()).toEqual(before);
  await select('none','none');const after=await profile();
  await expect(setTaxProfileMY(adminCtx(b),{personId:e.personId,employmentId:e.employmentId,expectedCompanyId:b.companyId,expectedApplicabilityEpoch:0,taxCircumstance:'single',taxResidency:'resident'})).rejects.toMatchObject({code:'stale_context'});
  expect(await profile()).toEqual(after);
 });
 it('full legacy writes preserve locked None and stale explicit full writes refuse reactivation',async()=>{
  await select('none','none');const current=await profile();
  await setStatutoryProfileMY(adminCtx(b),{personId:e.personId,icNumber:current.icNumber,taxCategory:1,numChildren:2});
  expect(await profile()).toMatchObject({taxCircumstance:'none',taxCategory:3,taxApplicabilityEpoch:1,numChildren:2});
  await expect(setStatutoryProfileMY(adminCtx(b),{personId:e.personId,icNumber:current.icNumber,taxCircumstance:'single',taxCategory:1})).rejects.toMatchObject({code:'stale_context'});
  await expect(setStatutoryProfileMY(adminCtx(b),{personId:e.personId,icNumber:current.icNumber,taxCircumstance:'single',expectedApplicabilityEpoch:0,taxCategory:1})).rejects.toMatchObject({code:'stale_context'});
 });
 it('company correction keeps None dormant and requires the destination current choice on reactivation',async()=>{
  const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic transfer employer'}).returning();const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Synthetic transfer department'}).returning();await select('none','none');await changeEmploymentCompany(adminCtx(b),{employmentId:e.employmentId,newCompanyId:company.id,departmentId:dept.id});
  expect(await resolve(e.employmentId,company.id)).toMatchObject({scheme:'none',taxCircumstance:{epoch:1}});const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);await setTaxProfileMY(adminCtx(b),{personId:e.personId,employmentId:e.employmentId,expectedCompanyId:company.id,expectedSelectionVersion:view.version,expectedApplicabilityEpoch:view.taxApplicabilityEpoch,taxCircumstance:'widow_divorced',taxResidency:'resident'});expect(await resolve(e.employmentId,company.id)).toMatchObject({scheme:'resident',taxCircumstance:{epoch:2}});
 });
 it('actual concurrent save read resolver and generation wait on one person owner without deadlock',async()=>{
  await select('none','none');const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);const run=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:period});
  let release!:()=>void;const released=new Promise<void>(r=>{release=r;});let locked!:(x:string)=>void;const lockedOwner=new Promise<string>(r=>{locked=r;});
  const holder=owner.db.transaction(async tx=>{await tx.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)).for('update');const rows=await tx.execute(sql`SELECT txid_current()::text AS id`);locked(String(rows[0].id));await released;});
  const xid=await lockedOwner;
  const operations=Promise.all([getTaxSelectionMY(adminCtx(b),e.employmentId),resolve(),saveTaxSelectionMY(adminCtx(b),{employmentId:e.employmentId,expectedCompanyId:b.companyId,expectedVersion:view.version,scheme:'none'}),generatePayslips(adminCtx(b),{batchId:run.batchId})]);
  try{
    // Observe real blocked transactions on the held owner; this is an overlap assertion, not a timing guess.
    const deadline=Date.now()+5000;let blocked=0;
    do{const rows=await owner.db.execute(sql`SELECT count(*)::integer AS blocked FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=${xid} AND NOT granted`);blocked=Number(rows[0].blocked);if(blocked<1)await new Promise(r=>setTimeout(r,25));}while(blocked<1&&Date.now()<deadline);
    expect(blocked).toBeGreaterThanOrEqual(1);
  }finally{release();await holder;}
  await operations;expect(await profile()).toMatchObject({taxCircumstance:'none',taxApplicabilityEpoch:1});expect((await slip(run.batchId)).statutory).toMatchObject({pcb:0,pcbBonus:0});
 });
 it('additional bonus processing after prior taxable PCB keeps None zero with no refund',async()=>{
  await setModule(b.tenantId,'multi_cycle_payroll','active');await setModule(b.tenantId,'typed_pay_components','active');const ctx=await entitledCtx(b);
  const regular=await createBatch(ctx,{companyId:b.companyId,payPeriod:period});await select('widow_divorced','resident');await generatePayslips(ctx,{batchId:regular.batchId});const paid=await slip(regular.batchId);expect(Number((paid.statutory as {pcb:number}).pcb)).toBeGreaterThan(0);
  await select('none','none');await seedPayComponentCatalog(ctx);const [bonus]=await owner.db.select().from(schema.payComponent).where(and(eq(schema.payComponent.tenantId,b.tenantId),eq(schema.payComponent.code,'BONUS')));
  const extra=await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'});await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:e.employmentId,componentId:bonus.id,amount:2000});await generatePayslips(ctx,{batchId:extra.batchId});expect((await slip(extra.batchId)).statutory).toMatchObject({pcb:0,pcbBonus:0,pcbMeta:{notSubjectToIncomeTax:true}});expect(await slip(regular.batchId)).toEqual(paid);
 });
 it('worksheet replays saved None after the current profile becomes taxable',async()=>{
  await setModule(b.tenantId,'multi_cycle_payroll','active');await setModule(b.tenantId,'typed_pay_components','active');const ctx=await entitledCtx(b);await select('none','none');
  const regular=await createBatch(ctx,{companyId:b.companyId,payPeriod:period});await generatePayslips(ctx,{batchId:regular.batchId});await seedPayComponentCatalog(ctx);const [bonus]=await owner.db.select().from(schema.payComponent).where(and(eq(schema.payComponent.tenantId,b.tenantId),eq(schema.payComponent.code,'BONUS')));const extra=await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'});await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:e.employmentId,componentId:bonus.id,amount:2000});await generatePayslips(ctx,{batchId:extra.batchId});
  const before=await multiCycleWorksheetMY(ctx,{companyIds:[b.companyId]});expect(before.employeeMonthsCompared).toBe(1);expect(before.employeeMonthsExcluded).toBe(0);await select('widow_divorced','resident');expect(await multiCycleWorksheetMY(ctx,{companyIds:[b.companyId]})).toEqual(before);
 });
 it('cross-employer saved None bypasses and present malformed or mixed history is unavailable',async()=>{
  const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic report employer'}).returning();const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Synthetic report department'}).returning();const other=await hireEmployee(adminCtx(b),{person:{id:e.personId},companyId:company.id,departmentId:dept.id,employmentType:'full_time',hiredOn});await setCompensation(adminCtx(b),{employmentId:other.employmentId,basicSalary:8000,effectiveFrom:hiredOn});await select('none','none');
  const batches=[];for(const companyId of [b.companyId,company.id]){const run=await createBatch(adminCtx(b),{companyId,payPeriod:period});await generatePayslips(adminCtx(b),{batchId:run.batchId});batches.push(run.batchId);}
  expect(await crossEmployerPcbExposure(adminCtx(b),period)).toEqual([expect.objectContaining({combinedMtd:0,summedMtd:0,delta:0})]);
  const [row]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batches[1]));const original=row.statutory as {pcbMeta:Record<string,unknown>};
  await owner.db.update(schema.payslip).set({statutory:{...original,pcbMeta:{...original.pcbMeta,taxCircumstance:{version:1,key:'none',category:3,applicable:false,epoch:1}}}}).where(eq(schema.payslip.id,row.id));expect(await crossEmployerPcbExposure(adminCtx(b),period)).toEqual([]);
  const {taxCircumstance:ignored,...legacy}=original.pcbMeta;await owner.db.update(schema.payslip).set({statutory:{...original,pcbMeta:legacy}}).where(eq(schema.payslip.id,row.id));expect(await crossEmployerPcbExposure(adminCtx(b),period)).toEqual([]);
 });
 it('ordinary and selected real processing bypass PCB, suppress saved override and preserve historical run',async()=>{
  const batch=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:period});await select('widow_divorced','resident');await generatePayslips(adminCtx(b),{batchId:batch.batchId});const before=await slip(batch.batchId);
  expect(Number((before.statutory as {pcb:number}).pcb)).toBeGreaterThan(0);
  await saveStatutoryAdjustment(adminCtx(b),{batchId:batch.batchId,employmentId:e.employmentId,values:{pcb:321,epfEmployee:123},reason:'Synthetic earlier taxable adjustment'});
  await select('none','none');expect(await slip(batch.batchId)).toEqual(before);
  await generatePayslips(adminCtx(b),{batchId:batch.batchId,reprocessSubset:{employmentIds:[e.employmentId]}});const none=await slip(batch.batchId);
  expect(none.statutory).toMatchObject({pcb:0,pcbBonus:0,epfEmployee:123,pcbMeta:{notSubjectToIncomeTax:true},pcbAdjustmentSuppressed:{requested:321}});
  expect(pcbTaxCategoryIdentity(explainPcb(none.statutory,null))).toMatchObject({applicable:false,labelKey:'taxCategoryNone'});
  await expect(saveStatutoryAdjustment(adminCtx(b),{batchId:batch.batchId,employmentId:e.employmentId,values:{pcb:1},reason:'Synthetic forbidden current adjustment'})).rejects.toThrow('Tax Category is None');
  await generatePayslips(adminCtx(b),{batchId:batch.batchId});expect((await slip(batch.batchId)).statutory).toMatchObject({pcb:0,pcbBonus:0});
 });
});
