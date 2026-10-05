import { describe,it,expect,beforeAll,beforeEach,afterAll } from 'vitest';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch,generatePayslips,closeBatch,payslipDetail } from '../core/payroll';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminCtx,owner,migrateTestDb,resetDb,seedBase,closeAll,createAppUser,harnessSnapshot,type Base } from './harness';
import * as schema from '../db/schema';
import { getPayslipInformationSettings,setPayslipInformationSettings } from '../core/payslip-information-settings';
import { DEFAULT_PAYSLIP_INFORMATION_FIELDS } from '../core/payslip-information';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase()});afterAll(closeAll);
const ctx=()=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:base.companyId}]});
describe('company-owned payslip display setting',()=>{
 it('has explicit defaults, saves an empty selection, persists ordered independent company choices and an audit event',async()=>{
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual(DEFAULT_PAYSLIP_INFORMATION_FIELDS);
  await setPayslipInformationSettings(ctx(),base.companyId,['branch','employee','daysWorked']);
  // r389 (23bd49d9) reversed the r378 re-sort: the saved list IS the payslip's reading order, so a
  // non-catalogue order comes back exactly as saved (it used to come back as employee, branch, daysWorked).
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual(['branch','employee','daysWorked']);
  await setPayslipInformationSettings(ctx(),base.companyId,[]);
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual([]);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'payslip-information.changed'));
  expect(events).toHaveLength(2);
 });
 it('rejects unknown fields and another company without changing the saved setting',async()=>{
  await setPayslipInformationSettings(ctx(),base.companyId,['employee']);
  await expect(setPayslipInformationSettings(ctx(),base.companyId,['bankAccount'])).rejects.toThrow('Unknown');
  await expect(setPayslipInformationSettings(ctx(),randomUUID(),['employee'])).rejects.toThrow('Forbidden');
  await expect(getPayslipInformationSettings({...ctx(),roles:['employee'],grants:[]},base.companyId)).rejects.toThrow('Forbidden');
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual(['employee']);
 });
 it('keeps opposite company choices independent and refuses foreign-tenant writes',async()=>{
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Synthetic Other Company'}).returning();
  const both={...ctx(),grants:[{role:'hr_admin',companyId:base.companyId},{role:'hr_admin',companyId:other.id}]};
  await setPayslipInformationSettings(both,base.companyId,['employee']);await setPayslipInformationSettings(both,other.id,['branch']);
  expect(await getPayslipInformationSettings(both,base.companyId)).toEqual(['employee']);expect(await getPayslipInformationSettings(both,other.id)).toEqual(['branch']);
  const [foreignTenant]=await owner.db.insert(schema.tenant).values({name:'Synthetic foreign tenant',workosOrgId:randomUUID()}).returning();
  const [foreign]=await owner.db.insert(schema.company).values({tenantId:foreignTenant.id,legalName:'Synthetic Foreign Company'}).returning();
  await expect(setPayslipInformationSettings({...ctx(),grants:[{role:'hr_admin',companyId:foreign.id}]},foreign.id,['employee'])).rejects.toThrow();
  await expect(getPayslipInformationSettings({...ctx(),grants:[{role:'hr_admin',companyId:foreign.id}]},foreign.id)).rejects.toThrow('Forbidden');
  await expect(withTenant(ctx(),tx=>tx.insert(schema.payslipInformationSetting).values({tenantId:base.tenantId,companyId:foreign.id,fields:['employee']}))).rejects.toThrow();
 });
 it('employee settings access exists only for their released payroll company and never permits editing',async()=>{
  const a=adminCtx(base);
  const e=await hireEmployee(a,{person:{fullName:'Synthetic Released Employee',primaryEmail:'synthetic-release@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  await setCompensation(a,{employmentId:e.employmentId,basicSalary:3000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900101011234'});
  const userId=await createAppUser(base.tenantId,e.personId,'employee');
  const ess={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};
  await setPayslipInformationSettings(ctx(),base.companyId,['employee','daysWorked']);
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Synthetic Hidden Settings'}).returning();
  await setPayslipInformationSettings({...ctx(),grants:[{role:'hr_admin',companyId:other.id}]},other.id,['branch']);
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-03'});await generatePayslips(a,{batchId});
  const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
  const read=()=>withTenant(ess,tx=>tx.select().from(schema.payslipInformationSetting));
  expect(await read()).toEqual([]);expect(await payslipDetail(ess,slip.id)).toBeNull();
  await closeBatch(a,{batchId});
  expect((await read()).map(r=>r.companyId)).toEqual([base.companyId]);
  expect((await payslipDetail(ess,slip.id))?.informationFields).toEqual(['employee','daysWorked']);
  await expect(setPayslipInformationSettings(ess,base.companyId,[])).rejects.toThrow('Forbidden');
 });

});
