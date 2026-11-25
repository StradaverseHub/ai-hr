// PROBE (not for merge): records what a company-scoped HR administrator can read on the Audit Trail today.
// It asserts the CURRENT behaviour so a run on Actions shows the exposure with real rows. The narrowing change
// replaces this file with leakage tests that assert the opposite.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {company,department,roleAssignment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {auditEvents,auditEventsCount,auditActors,listCompanies} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);

const hire=(name:string,companyId:string,departmentId:string)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`probe-${randomUUID()}@example.test`},companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});

describe('PROBE: Audit Trail visibility for a company-scoped HR administrator (current behaviour)',()=>{
 it('reads other-company and tenant-level events, including payloads',async()=>{
  const [foreignCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Probe Foreign Sdn Bhd',country:'MY',currency:'MYR'}).returning({id:company.id});
  const [foreignDept]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:foreignCompany.id,name:'PROBE-FOREIGN'}).returning({id:department.id});
  const local=await hire('Probe local admin',b.companyId,b.deptA);
  const localSubject=await hire('Probe local subject',b.companyId,b.deptA);
  const foreignSubject=await hire('Probe foreign subject',foreignCompany.id,foreignDept.id);

  const group=adminCtx(b);
  const marker=`probe-${randomUUID().slice(0,8)}`;
  const events=[
   {key:'local-subject',aggregateType:'employment',aggregateId:localSubject.employmentId,subjectEmploymentId:localSubject.employmentId,payload:{note:'local'}},
   {key:'local-company',aggregateType:'company',aggregateId:b.companyId,payload:{companyId:b.companyId}},
   {key:'foreign-subject',aggregateType:'employment',aggregateId:foreignSubject.employmentId,subjectEmploymentId:foreignSubject.employmentId,payload:{note:'foreign-secret'}},
   {key:'foreign-company',aggregateType:'company',aggregateId:foreignCompany.id,payload:{companyId:foreignCompany.id,note:'foreign-secret'}},
   {key:'foreign-no-payload-company',aggregateType:'pay-period',aggregateId:randomUUID(),payload:{note:'company only via aggregate'}},
   {key:'tenant-level',aggregateType:'tenant-setting',aggregateId:b.tenantId,payload:{key:'probe.setting'}},
  ];
  await withTenant(group,async tx=>{for(const e of events)await appendEvent(tx,{tenantId:b.tenantId,actor:actorOf(group),aggregateType:e.aggregateType,aggregateId:e.aggregateId,subjectEmploymentId:e.subjectEmploymentId,eventType:`${marker}.${e.key}`,payload:e.payload});});

  const userId=await createAppUser(b.tenantId,local.personId,'hr_admin');
  await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,userId));
  const scoped={...adminCtx(b),userId,personId:local.personId,employmentIds:[local.employmentId],grants:[{role:'hr_admin' as const,companyId:b.companyId}]};

  const rows=(await auditEvents(scoped,{eventQuery:marker,limit:500})).filter(r=>r.eventType.startsWith(marker));
  const seen=rows.map(r=>r.eventType.slice(marker.length+1)).sort();
  console.log('[probe] company-scoped admin sees',JSON.stringify(seen));
  console.log('[probe] foreign payloads visible',JSON.stringify(rows.filter(r=>JSON.stringify(r.payload).includes('foreign-secret')).map(r=>r.payload)));
  expect(seen).toEqual(events.map(e=>e.key).sort());
  expect(await auditEventsCount(scoped,{eventQuery:marker})).toBe(events.length);
  // The Company filter narrows only by payload companyId; it does not stop the default unfiltered read.
  expect((await auditEvents(scoped,{companyId:foreignCompany.id,eventQuery:marker})).map(r=>r.eventType.slice(marker.length+1))).toEqual(['foreign-company']);
  // The page's Company dropdown (listCompanies without adminOnly) lists the foreign company too.
  const offered=(await listCompanies(scoped)).map(c=>c.id);
  console.log('[probe] company filter offers foreign company',offered.includes(foreignCompany.id));
  expect(offered).toContain(foreignCompany.id);
  // The User filter lists actors from every company's events.
  expect((await auditActors(scoped)).length).toBeGreaterThan(0);
 });
});
