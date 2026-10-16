/** Real restricted-app read regression; canonical writes/generation establish ordinary cycle identity.
 * Owner-only inconsistent-reference controls model bad legacy data, never authorize it or bypass guards.
 * September work / October 2026 processing are deliberately fixed acceptance facts, not a clock-derived
 * pay period. The employee predates that whole period, so full-month basic 5000 + explicit earning100
 * gives gross5100 independently of today's date; no current-day rate/calendar assertion is inferred.
 */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assignRole,createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips} from '../core/payroll';
import {createPayComponent} from '../core/pay-components';
import {upsertPayrollCycle,setPayrollCycleActive} from '../core/payroll-cycle';
import {createIndividualTxn,createIndividualTxnsBulk} from '../core/payroll-individual-txn';
import {listIndividualTxnsAcross} from '../core/payroll-view';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
describe('39c7 configured cycle labels on the actual Individual Transaction read',()=>{
 let base:Base,ctx:SessionContext,employmentId:string,personId:string,componentId:string;
 beforeAll(migrateTestDb);afterAll(closeAll);
 beforeEach(async()=>{
  await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');await setSetting(base.tenantId,'payroll.individual_txn_pay_enabled',true);ctx=await entitledCtx(base);
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional cycle detail',primaryEmail:randomUUID()+'@demo.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});employmentId=hired.employmentId;personId=hired.personId;
  await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:'2026-01-01'});await setStatutoryProfileMY(ctx,{personId,icNumber:'900101011234'});
  const component=await createPayComponent(ctx,{code:'CYCLE_DETAIL',name:'Fictional cycle earning',kind:'allowance',includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false});componentId=component.id;
 });
 const rows=()=>listIndividualTxnsAcross(ctx,{companyIds:[base.companyId],employmentId,year:2026,month:10});
 const cycle=(name:string,runType:'regular'|'off_cycle'='regular',companyId=base.companyId)=>upsertPayrollCycle(ctx,{companyId,name,runType});
 it('projects the exact selected Monthly cycle after real generation without changing the prior-month date or paid amount',async()=>{
  const monthly=await cycle('Monthly');const batch=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-10',payrollCycleId:monthly.id});
  const created=await createIndividualTxnsBulk(ctx,{companyId:base.companyId,payPeriod:'2026-10',employmentIds:[employmentId],intendedCycleId:monthly.id,rows:[{kind:'earning',componentId,txnDate:'2026-09-02',amount:100}]});expect(created.ids).toHaveLength(1);const txnId=created.ids[0];
  await generatePayslips(ctx,{batchId:batch.batchId});
  const read=await rows();expect(read).toHaveLength(1);expect(read[0]).toMatchObject({id:txnId,txnDate:'2026-09-02',payPeriod:'2026-10',batchStatus:'processed',runType:'regular',batchCycleId:monthly.id,batchCycleName:'Monthly',intendedCycleId:monthly.id,intendedCycleName:'Monthly'});
  const slips=await owner.db.select({gross:s.payslip.grossPay}).from(s.payslip).where(eq(s.payslip.batchId,batch.batchId));expect(slips).toHaveLength(1);expect(Number(slips[0].gross)).toBe(5100);
 });
 it('keeps two distinct off-cycle names on unattached rows even when a selected cycle is later archived',async()=>{
  const advance=await cycle('Advance Salary','off_cycle'),mid=await cycle('Mid-Month','off_cycle');
  for(const [id,day]of [[advance.id,'2026-09-02'],[mid.id,'2026-09-03']])await createIndividualTxnsBulk(ctx,{companyId:base.companyId,payPeriod:'2026-10',employmentIds:[employmentId],intendedCycleId:id,rows:[{kind:'earning',componentId,txnDate:day,amount:100}]});
  await setPayrollCycleActive(ctx,{id:advance.id,active:false});const read=await rows();expect(read).toHaveLength(2);
  expect(read.find(r=>r.txnDate==='2026-09-02')).toMatchObject({batchCycleId:null,batchCycleName:null,intendedCycleId:advance.id,intendedCycleName:'Advance Salary'});
  expect(read.find(r=>r.txnDate==='2026-09-03')).toMatchObject({batchCycleId:null,batchCycleName:null,intendedCycleId:mid.id,intendedCycleName:'Mid-Month'});
 });
 it('retains a known reference but exposes no other-company or other-tenant cycle name; true legacy NULL stays NULL',async()=>{
  const batch=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-10'});const txn=await createIndividualTxn(ctx,{batchId:batch.batchId,employmentId,kind:'earning',componentId,txnDate:'2026-09-02',amount:100});
  const otherCompany=await createCompany(ctx,{legalName:'Fictional other cycle company'});const otherCycle=await cycle('Not this company', 'off_cycle',otherCompany.id);
  // Narrow owner fixture: a valid FK with inconsistent company/tenant must not become label authority.
  await owner.db.update(s.payrollBatch).set({payrollCycleId:otherCycle.id}).where(eq(s.payrollBatch.id,batch.batchId));
  expect((await rows())[0]).toMatchObject({id:txn.id,batchCycleId:otherCycle.id,batchCycleName:null,intendedCycleId:null,intendedCycleName:null});
  const foreign=await seedBase();const foreignCycle=await upsertPayrollCycle(adminCtx(foreign),{companyId:foreign.companyId,name:'Other tenant private cycle',runType:'off_cycle'});
  await owner.db.update(s.payrollBatch).set({payrollCycleId:foreignCycle.id}).where(eq(s.payrollBatch.id,batch.batchId));
  expect((await rows())[0]).toMatchObject({batchCycleId:foreignCycle.id,batchCycleName:null});
  await owner.db.update(s.payrollBatch).set({payrollCycleId:null}).where(eq(s.payrollBatch.id,batch.batchId));expect((await rows())[0]).toMatchObject({batchCycleId:null,batchCycleName:null,intendedCycleId:null,intendedCycleName:null,runType:'regular'});
 });
 it('does not widen restricted employee, company-scoped HR or other-tenant reads through the cycle joins',async()=>{
  const monthly=await cycle('Monthly');await createIndividualTxnsBulk(ctx,{companyId:base.companyId,payPeriod:'2026-10',employmentIds:[employmentId],intendedCycleId:monthly.id,rows:[{kind:'earning',componentId,txnDate:'2026-09-02',amount:100}]});
  const employeeUser=await createAppUser(base.tenantId,personId,'employee');const employeeCtx={...ctx,userId:employeeUser,personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};expect(await listIndividualTxnsAcross(employeeCtx,{companyIds:[base.companyId]})).toEqual([]);
  const otherCompany=await createCompany(ctx,{legalName:'Fictional scoped HR company'});const [user]=await owner.db.insert(s.appUser).values({tenantId:base.tenantId,personId,workosUserId:'fixture:'+randomUUID()}).returning({id:s.appUser.id});await assignRole(ctx,{appUserId:user.id,role:'hr_admin',companyId:otherCompany.id});
  const actualGrants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));const scoped={...ctx,userId:user.id,personId,roles:[...new Set(actualGrants.map(g=>g.role))],grants:actualGrants};expect(await listIndividualTxnsAcross(scoped,{companyIds:[base.companyId]})).toEqual([]);
  const foreign=await seedBase();expect(await listIndividualTxnsAcross(await entitledCtx(foreign),{companyIds:[base.companyId]})).toEqual([]);expect(await listIndividualTxnsAcross(ctx,{companyIds:[]})).toEqual([]);
 });
});
