import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {company,department,roleAssignment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {auditEvents,auditEventsCount,employeeAudit} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const hire=(name:string,companyId=b.companyId,departmentId=b.deptA)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`audit-${randomUUID()}@example.test`},companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
describe('Personnel subject in the central Audit Trail',()=>{
 it('unifies employment, profile, compensation and subject-tagged events without mixing another employee; count and legacy consumer agree',async()=>{
  const ctx=adminCtx(b),a=await hire('Audit A'),other=await hire('Audit B');
  await setCompensation(ctx,{employmentId:a.employmentId,effectiveFrom:todayInKualaLumpur(),basicSalary:1000});
  const events=[
   {aggregateType:'employment',aggregateId:a.employmentId,eventType:'personnel-probe.employment'},
   {aggregateType:'person',aggregateId:a.personId,eventType:'personnel-probe.profile'},
   {aggregateType:'independent-record',aggregateId:randomUUID(),subjectEmploymentId:a.employmentId,eventType:'personnel-probe.related'},
   {aggregateType:'employment',aggregateId:other.employmentId,eventType:'personnel-probe.other'},
  ];
  await withTenant(ctx,async tx=>{for(const event of events)await appendEvent(tx,{tenantId:b.tenantId,actor:actorOf(ctx),payload:{},...event});});
  const filter={employmentId:a.employmentId,limit:500};const rows=await auditEvents(ctx,filter);
  expect(rows.filter(row=>row.eventType.startsWith('personnel-probe.')).map(row=>row.eventType).sort()).toEqual(['personnel-probe.employment','personnel-probe.profile','personnel-probe.related']);
  expect(rows.some(row=>row.aggregateType==='compensation')).toBe(true);
  expect(await auditEventsCount(ctx,filter)).toBe(rows.length);
  expect(await employeeAudit(ctx,a.employmentId,500)).toEqual(rows);
  expect((await auditEvents(ctx,{...filter,limit:1}))).toEqual(rows.slice(0,1));
 });
 it('requires current Workforce visibility for the selected subject even if the caller can reach the audit module',async()=>{
  const local=await hire('Local audit administrator');
  const [foreignCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Foreign audit company',country:'MY',currency:'MYR'}).returning({id:company.id});
  const [foreignDepartment]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:foreignCompany.id,name:'FOREIGN'}).returning({id:department.id});
  const foreign=await hire('Foreign subject',foreignCompany.id,foreignDepartment.id);
  const userId=await createAppUser(b.tenantId,local.personId,'hr_admin');
  await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,userId));
  const ctx={...adminCtx(b),userId,personId:local.personId,employmentIds:[local.employmentId],grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
  expect((await auditEvents(ctx,{employmentId:local.employmentId})).length).toBeGreaterThan(0);
  expect(await auditEvents(ctx,{employmentId:foreign.employmentId})).toEqual([]);
  expect(await auditEventsCount(ctx,{employmentId:foreign.employmentId})).toBe(0);
  expect(await auditEvents(ctx,{employmentId:randomUUID()})).toEqual([]);
 });
});
