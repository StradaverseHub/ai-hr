import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFormatter, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import { captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
const copies={en,ms,zh,vi:viCopy,th,ta};
const visual=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'th'|'ta'}));
vi.mock('next-intl/server',()=>({
 getTranslations:async(namespace:any)=>createTranslator({locale:visual.locale,messages:copies[visual.locale],namespace}),
 getFormatter:async()=>createFormatter({locale:visual.locale,timeZone:'Asia/Kuala_Lumpur'}),
}));
import { RankedBuildList } from '../app/(app)/control-tower/opportunities/build-list';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { agentBuildList } from '../core/agent-build-list';
import { assessProcesses } from '../core/process-assessment';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';

let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(closeAll);
const group=async()=>({...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]});
async function leaveFixture(people:number,actions:number){
 for(let i=0;i<people;i++){
  const employee=await hireEmployee(adminCtx(base),{person:{fullName:`Build fixture ${i}`,primaryEmail:`build.${i}.${randomUUID()}@example.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'} as never);
  const [request]=await owner.db.insert(schema.leaveRequest).values({tenantId:base.tenantId,employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:'2026-01-05',endDate:'2026-01-05',days:'1',status:'pending'}).returning({id:schema.leaveRequest.id});
  for(let n=0;n<actions;n++)await owner.db.insert(schema.domainEvent).values({tenantId:base.tenantId,aggregateType:'leave-request',aggregateId:request.id,eventType:'leave-request.fixture-staff-action',actorType:'user',actorId:base.adminUserId,subjectEmploymentId:employee.employmentId});
 }
}
describe('group-admin ranked build-list source',()=>{
 it('reconciles recorded process work and distinct people with the canonical assessment',async()=>{
  await leaveFixture(2,3);
  const ctx=await group(),view=await agentBuildList(ctx,30),assessment=await assessProcesses(ctx,30);
  const source=assessment.processes.find(p=>p.id==='leave')!;
  expect(source.staffActionsPer30).toBe(6);expect(source.peopleAffected).toBe(2);
  const entry=view.entries.find(r=>r.id==='app/(app)/leave/actions.ts#adminCancelLeaveAction')!;
  expect(entry).toMatchObject({basis:'leave',staffActionsPer30:6,peopleAffected:2,measurement:'measured'});
  expect(view.entries.filter(r=>r.basis==='leave').every(r=>r.staffActionsPer30===source.staffActionsPer30&&r.peopleAffected===source.peopleAffected)).toBe(true);
  expect(view.entries).toHaveLength(Object.values(view.totals).reduce((n,v)=>n+v,0));
  expect(JSON.stringify(view.entries)).not.toContain('Build fixture');
  expect(JSON.stringify(view.entries)).not.toContain(base.adminUserId);
  for(const locale of Object.keys(copies) as (keyof typeof copies)[]){
   visual.locale=locale;
   const html=renderToStaticMarkup(await RankedBuildList({view}));
   expect(html).toContain(copies[locale].processAssessment.buildList.title);
   expect(html).toContain('adminCancelLeaveAction');
   expect(html).not.toContain('Build fixture');
   await captureAiReviewScreenshots(html,locale,'build-list');
  }
 },120000);
 it('refuses company HR and ordinary employees and isolates another tenant even with nonempty source data',async()=>{
  await leaveFixture(1,4);
  const ctx=await group();
  expect((await agentBuildList(ctx,30)).entries.some(r=>r.staffActionsPer30===4)).toBe(true);
  await expect(agentBuildList({...ctx,grants:[{role:'hr_admin',companyId:base.companyId}]},30)).rejects.toThrow('Only group');
  await expect(agentBuildList({...ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]},30)).rejects.toThrow('Only group');
  const original=base;try{base=await seedBase();const other=await agentBuildList(await group(),30);expect(other.entries.filter(r=>r.measurement==='measured').every(r=>r.staffActionsPer30===0&&r.peopleAffected===0)).toBe(true);}finally{base=original;}
 });
 it('refuses a stale archived administrator even when the supplied grants still say group HR',async()=>{
  const ctx=await group();
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));
  await expect(agentBuildList(ctx,30)).rejects.toThrow('calling authority');
 });
 it('uses newly resolved module availability instead of a stale entitlement snapshot',async()=>{
  const ctx=await group();
  await setModule(base.tenantId,'claims','disabled');
  const view=await agentBuildList(ctx,30);
  expect(view.entries.find(r=>r.id==='app/(app)/claims/actions.ts#submitClaimAction')).toMatchObject({measurement:'module_off',staffActionsPer30:null,peopleAffected:null});
 });
});
