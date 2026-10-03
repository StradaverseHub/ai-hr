import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips,saveStatutoryAdjustment} from '../core/payroll';
import {getTaxSelectionMY,resolveTaxSelectionMY,saveTaxSelectionMY} from '../localization/my/tax-selection';
import {setStatutoryProfileMY,setTaxProfileMY} from '../localization/my/statutory';
import {explainPcb,pcbTaxCategoryIdentity} from '../core/pcb-explain';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
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
