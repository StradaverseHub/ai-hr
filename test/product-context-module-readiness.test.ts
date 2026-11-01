/** ADR-0169 phase B: leave, holiday, attendance and onboarding setup readiness on fictional data. */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {holidayYears,type ModuleReadiness} from '../core/product-context/module-readiness';
import {runContextTool} from '../core/product-context/tools';
import {defaultConfig} from '../lib/onboarding-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();});
const NAMES=['Fictional Readiness Employee','Fictional Readiness Admin'];
async function hr():Promise<SessionContext>{
 const admin=adminCtx(base);
 await hireEmployee(admin,{person:{fullName:NAMES[0],primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const person=await hireEmployee(admin,{person:{fullName:NAMES[1],primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,person.personId,'hr_admin');
 return {...await entitledCtx(base,['hr_admin']),userId,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
}
async function modules(ctx:SessionContext):Promise<ModuleReadiness>{
 const result=await runContextTool(ctx,'setup_readiness',{},{companyId:base.companyId,locale:'en'});
 expect(result.ok).toBe(true);if(!result.ok)throw new Error('refused');
 return (result.content as {modules:ModuleReadiness}).modules;
}

describe('Assistant setup readiness for leave, attendance and onboarding',()=>{
 it('checks this year\'s public holidays, and next year\'s from November',()=>{
  expect(holidayYears('2026-10-31')).toEqual([2026]);
  expect(holidayYears('2026-11-01')).toEqual([2026,2027]);
  expect(holidayYears('2027-01-15')).toEqual([2027]);
 });
 it('reports each active leave type\'s entitlement health, and names a leave type with no earning method as blocked',async()=>{
  const ctx=await hr();
  await owner.db.update(schema.leaveType).set({accrualMethod:null,accrualUnconfigured:new Date()}).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
  const [annual]=await owner.db.select({name:schema.leaveType.name}).from(schema.leaveType).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
  const active=await owner.db.select({id:schema.leaveType.id}).from(schema.leaveType).where(and(eq(schema.leaveType.tenantId,base.tenantId),isNull(schema.leaveType.archivedAt)));
  const leave=(await modules(ctx)).leave;
  expect(leave).not.toBeNull();
  expect(leave!.types).toHaveLength(active.length);
  expect(leave!.blocked+leave!.warning+leave!.ready).toBe(active.length);
  const row=leave!.types.find(type=>type.name===annual.name);
  expect(row?.status).toBe('blocked');expect(row?.findings).toContain('no_earning_method');
 });
 it('counts the gazetted public holidays loaded for the company\'s country this year against the minimum',async()=>{
  const ctx=await hr(),year=Number(todayInKualaLumpur().slice(0,4));
  const [company]=await owner.db.select({country:schema.company.country}).from(schema.company).where(eq(schema.company.id,base.companyId));
  const count=async()=>(await owner.db.select({n:sql<number>`count(*)::int`}).from(schema.holiday).where(and(eq(schema.holiday.tenantId,base.tenantId),eq(schema.holiday.country,company.country),isNull(schema.holiday.state),isNull(schema.holiday.companyId),isNull(schema.holiday.holidayGroupId),sql`extract(year from ${schema.holiday.holidayDate}) = ${year}`)))[0].n;
  const before=await count();
  for(const day of ['03-01','03-02'])await owner.db.insert(schema.holiday).values({tenantId:base.tenantId,country:company.country,holidayDate:`${year}-${day}`,name:'Fictional Readiness Holiday '+day});
  const row=(await modules(ctx)).leave!.publicHolidays.find(holiday=>holiday.year===year);
  expect(row).toEqual({country:company.country,year,loaded:before+2,required:11});
 });
 it('counts current employments in the company with no schedule group',async()=>{
  const ctx=await hr();
  const [expected]=await owner.db.select({current:sql<number>`count(*)::int`,without:sql<number>`count(*) filter (where ${schema.employment.attendanceRuleId} is null)::int`}).from(schema.employment)
   .where(and(eq(schema.employment.companyId,base.companyId),isNull(schema.employment.terminatedOn)));
  const groups=await owner.db.select({isDefault:schema.attendanceRule.isDefault}).from(schema.attendanceRule).where(eq(schema.attendanceRule.tenantId,base.tenantId));
  const attendance=(await modules(ctx)).attendance;
  expect(expected.current).toBeGreaterThanOrEqual(2);
  expect(attendance).toEqual({scheduleGroups:groups.length,hasDefaultGroup:groups.some(group=>group.isDefault),currentEmployments:expected.current,employmentsWithoutGroup:expected.without,page:'/admin/attendance/schedule'});
 });
 it('leaves onboarding out when the module is off, and counts its configuration when it is on',async()=>{
  expect((await modules(await hr())).onboarding).toBeNull();
  await setModule(base.tenantId,'lifecycle','active');
  const ctx=await hr();
  await owner.db.insert(schema.lcOnboardingConfig).values({tenantId:base.tenantId,revision:1,data:defaultConfig(ctx.userId!)});
  // The default configuration: one General onboarding checklist with no tasks, one approval workflow, an empty catalogue, the owner holding access.
  expect((await modules(ctx)).onboarding).toEqual({initialized:true,checklists:1,checklistsWithoutTasks:1,workflows:1,activeCatalogueItems:0,onboardingAccessHolders:1,page:'/admin/lifecycle/onboarding'});
 });
 it('links only real pages and carries no employee names',async()=>{
  await setModule(base.tenantId,'lifecycle','active');
  const ctx=await hr(),result=await modules(ctx);
  const pages=[result.leave?.pages.balanceHealth,result.leave?.pages.holidays,result.attendance?.page,result.onboarding?.page].filter((page):page is string=>Boolean(page));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  for(const page of pages)expect(existsSync(join(process.cwd(),'app',page,'page.tsx')),page).toBe(true);
  const body=JSON.stringify(result);for(const name of NAMES)expect(body.includes(name),name).toBe(false);expect(body).not.toMatch(/EMP-\d+/);
 });
});
