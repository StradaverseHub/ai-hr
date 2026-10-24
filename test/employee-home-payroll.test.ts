import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {appUser,roleAssignment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {readEmployeeHomePayHints} from '../core/employee-home';
import {readOwnPayrollHomeMetadata,readOwnPayrollCalendarPayments,createBatch,generatePayslips,closeBatch,unlockClosedBatch,setPayrollConfig,createIndividualTxn} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {dayAfter} from '../core/employment-company';
import {previousPayrollComparisonPeriod} from '../lib/payroll-period-comparison';
import {closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';

let b:Base,admin:SessionContext,period:string;
let icSequence=1234;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');
 await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:b.adminUserId,role:'super_admin',companyId:null});
 admin=await entitledCtx(b,['hr_admin','super_admin']);period=todayInKualaLumpur().slice(0,7);});
async function worker(role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(admin,{person:{fullName:'Fictional Home '+randomUUID(),primaryEmail:randomUUID()+'@example.test'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:previousPayrollComparisonPeriod(period)+'-01'});
 await setCompensation(admin,{employmentId:hired.employmentId,basicSalary:4321,effectiveFrom:previousPayrollComparisonPeriod(period)+'-01'});
 await requirePackFor('MY').statutory.set(admin,{personId:hired.personId,icNumber:'90010101'+String(icSequence++).padStart(4,'0')});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:[role],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
describe('Home consumes own salary-free Payroll metadata',()=>{
 it('hides processed slips, publishes after Close and hides again after Unlock with retained release timestamps',async()=>{
  const own=await worker();const batch=await createBatch(admin,{companyId:b.companyId,payPeriod:previousPayrollComparisonPeriod(period)});
  await generatePayslips(admin,{batchId:batch.batchId});
  expect(await readEmployeeHomePayHints(own.ctx,own.employmentId)).toEqual({version:1,employmentId:own.employmentId,payslips:[],nextPayment:null});
  await closeBatch(admin,{batchId:batch.batchId});
  const published=await readEmployeeHomePayHints(own.ctx,own.employmentId);
  expect(published.payslips).toHaveLength(1);
  expect(published.payslips[0]).toEqual({id:expect.any(String),period:previousPayrollComparisonPeriod(period),runType:'regular',runSequence:1});
  expect(Object.keys(published).sort()).toEqual(['employmentId','nextPayment','payslips','version']);
  for(const field of ['4321','gross','deductions','net','statutory','basicSalary','bank'])expect(JSON.stringify(published)).not.toContain(field);
  await setSetting(b.tenantId,'payroll.unlock_enabled',true);
  const unlockAdmin=await entitledCtx(b,['hr_admin','super_admin']);
  await unlockClosedBatch(unlockAdmin,{batchId:batch.batchId,reason:'Fictional Home publication regression'});
  expect((await readOwnPayrollHomeMetadata(own.ctx,own.employmentId)).payslips).toEqual([]);
 });
 it('honours scheduled release through the same canonical publication rule',async()=>{
  const own=await worker();await setPayrollConfig(admin,{companyId:b.companyId,payslipRelease:{mode:'relative',offsetDays:7}});
  const batch=await createBatch(admin,{companyId:b.companyId,payPeriod:period});await generatePayslips(admin,{batchId:batch.batchId});
  await closeBatch(admin,{batchId:batch.batchId});
  expect((await readOwnPayrollHomeMetadata(own.ctx,own.employmentId)).payslips).toEqual([]);
 });
 it('uses the actual recorded payment date only when this subject has a generated non-stale result',async()=>{
  const own=await worker();const date=dayAfter(todayInKualaLumpur());
  const batch=await createBatch(admin,{companyId:b.companyId,payPeriod:period,paymentDate:date});
  expect((await readOwnPayrollHomeMetadata(own.ctx,own.employmentId)).nextPayment).toBeNull();
  expect(await readOwnPayrollCalendarPayments(own.ctx,own.employmentId,date,date)).toEqual([]);
  await generatePayslips(admin,{batchId:batch.batchId});
  expect(await readOwnPayrollHomeMetadata(own.ctx,own.employmentId)).toEqual({version:1,employmentId:own.employmentId,payslips:[],nextPayment:{date,period,runType:'regular'}});
  expect(await readOwnPayrollCalendarPayments(own.ctx,own.employmentId,date,date)).toEqual([date]);
  expect(await readOwnPayrollCalendarPayments(own.ctx,own.employmentId,dayAfter(date),dayAfter(date))).toEqual([]);
  await createIndividualTxn(admin,{batchId:batch.batchId,employmentId:own.employmentId,kind:'earning',txnDate:period+'-01',amount:1});
  expect((await readOwnPayrollHomeMetadata(own.ctx,own.employmentId)).nextPayment).toBeNull();
  expect(await readOwnPayrollCalendarPayments(own.ctx,own.employmentId,date,date)).toEqual([]);
 });
 it('refuses foreign subjects even for HR, forged person context and a freshly archived login',async()=>{
  const own=await worker('hr_admin'),other=await worker();
  const batch=await createBatch(admin,{companyId:b.companyId,payPeriod:previousPayrollComparisonPeriod(period)});
  await generatePayslips(admin,{batchId:batch.batchId});await closeBatch(admin,{batchId:batch.batchId});
  for(const id of [other.employmentId,randomUUID(),''])await expect(readOwnPayrollHomeMetadata(own.ctx,id)).rejects.toMatchObject({name:'OwnPayrollSubjectUnavailableError'});
  for(const id of [other.employmentId,randomUUID(),''])await expect(readOwnPayrollCalendarPayments(own.ctx,id,period+'-01',period+'-02')).rejects.toMatchObject({name:'OwnPayrollSubjectUnavailableError'});
  const foreign=await seedBase();
  await expect(readOwnPayrollHomeMetadata({...own.ctx,tenantId:foreign.tenantId},own.employmentId)).rejects.toMatchObject({name:'EntitlementsTenantMismatchError'});
  await expect(readOwnPayrollHomeMetadata({...own.ctx,personId:other.personId},other.employmentId)).rejects.toMatchObject({name:'OwnPayrollSubjectUnavailableError'});
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,own.ctx.userId!));
  await expect(readOwnPayrollHomeMetadata(own.ctx,own.employmentId)).rejects.toMatchObject({name:'OwnPayrollSubjectUnavailableError'});
 });
});
