/** Decision 6 (migration 5744, core/probation.ts sweep): a case opens at activation, waits for the start date, and closes as Did not join. */
import {automationBusinessPartnerWorkspace,saveAutomationBusinessPartners} from '../packs/automation/service';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,probationActivationCounts,saveProbationConfiguration,sweepProbation} from '../packs/probation/service';

let b:Base,admin:SessionContext,grade:string;
async function saveBusinessPartners(rules:Parameters<typeof saveAutomationBusinessPartners>[1]['rules']){
 const current=await automationBusinessPartnerWorkspace(admin);
 if(!current)throw Error('The actual fixture administrator cannot configure Business Partner responsibilities.');
 await saveAutomationBusinessPartners(admin,{expectedRevision:current.revision,rules,reason:'Reviewed fictional Contract and Probation Business Partner responsibilities'});
}

const today=()=>todayInKualaLumpur();
const runner=()=>({...admin,userId:undefined,roles:[],grants:undefined}) as SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 for(const[kind,data]of [['settings',DEFAULT_PROBATION_CONFIG],['form',DEFAULT_PROBATION_FORM],['route',defaultProbationRoutes()]] as const)await saveProbationConfiguration(admin,{companyId:b.companyId,kind,data,publish:true,expectedVersion:0});
 await owner.db.execute(sql`insert into probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,true,${addDaysIso(today(),-60)}::date,${'a'.repeat(64)},${admin.userId}::uuid)`);
 grade=randomUUID();await owner.db.execute(sql`insert into job_grade(id,tenant_id,code,name) values(${grade}::uuid,${b.tenantId}::uuid,'12','Fictional Grade 12')`);
});
async function starter(startOn:string){
 const hire=await hireEmployee(admin,{person:{fullName:'Fictional new starter',primaryEmail:randomUUID()+'@activation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:startOn,gradeId:grade});
 await owner.db.execute(sql`update employment set probation_months=6,probation_unit='month',probation_value=6 where id=${hire.employmentId}::uuid`);
 return hire.employmentId;
}
async function caseOf(employmentId:string){
 const[row]=await owner.db.execute<{id:string;state:string;closure:string|null;startOn:string}>(sql`select id,data->>'state' as state,data->>'closure' as closure,data->>'startOn' as "startOn" from probation_case where employment_id=${employmentId}::uuid`);
 const parts=row?await owner.db.execute<{type:number;state:string}>(sql`select (data->>'type')::int as type,data->>'state' as state from probation_part where case_id=${row.id}::uuid order by (data->>'type')::int`):[];
 return row?{...row,parts:parts.map(p=>p.state)}:null;
}

describe('a probation case opens at activation',()=>{
 it('admits an activated employment before its start date and issues nothing until the start date',async()=>{
  const start=addDaysIso(today(),10),employmentId=await starter(start);
  const[source]=await owner.withTenant(runner(),tx=>tx.execute<{data:{employmentType:string|null;startOn:string}}>(sql`select app.probation_personnel_source(${employmentId}::uuid) as data`));
  expect(source.data).toMatchObject({employmentType:'full_time',startOn:start});
  await sweepProbation(runner(),owner);
  const opened=await caseOf(employmentId);
  expect(opened).toMatchObject({state:'kpi_setting',closure:null,startOn:start});
  expect(opened!.parts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(opened!.parts)).toEqual(new Set(['not_issued']));
  await sweepProbation(runner(),owner);
  expect(new Set((await caseOf(employmentId))!.parts)).toEqual(new Set(['not_issued']));
  const[part]=await owner.db.execute<{id:string}>(sql`select p.id from probation_part p join probation_case c on c.id=p.case_id where c.employment_id=${employmentId}::uuid and p.data->>'type'='1'`);
  await owner.db.execute(sql`update probation_part set data=jsonb_set(data,'{issueOn}',to_jsonb(${today()}::text)) where id=${part.id}::uuid`);
  const[issued]=await owner.withTenant(runner(),tx=>tx.execute<{issued:boolean}>(sql`select app.probation_issue(${part.id}::uuid,${today()}::date) as issued`));
  expect(issued.issued).toBe(false);
  const[occurrences]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_occurrence o join probation_case c on c.id=o.case_id where c.employment_id=${employmentId}::uuid`);
  expect(occurrences.n).toBe(0);
 });

 it('closes the case as Did not join when the start is cancelled before the start date',async()=>{
  const start=addDaysIso(today(),12),employmentId=await starter(start);
  await sweepProbation(runner(),owner);
  expect(await caseOf(employmentId)).toMatchObject({state:'kpi_setting'});
  await owner.db.execute(sql`update employment set terminated_on=${start}::date where id=${employmentId}::uuid`);
  await sweepProbation(runner(),owner);
  const closed=await caseOf(employmentId);
  expect(closed).toMatchObject({state:'withdrawn',closure:'did_not_join'});
  expect(new Set(closed!.parts)).toEqual(new Set(['cancelled']));
  const[audit]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and event_type='probation.did_not_join'`);
  expect(audit.n).toBe(1);
  await sweepProbation(runner(),owner);
  expect(await caseOf(employmentId)).toMatchObject({state:'withdrawn',closure:'did_not_join'});
 });

 it('keeps an exit after the start date an ordinary withdrawal and admits only activated, live employments',async()=>{
  const started=await starter(addDaysIso(today(),-5));
  await sweepProbation(runner(),owner);
  expect(await caseOf(started)).toMatchObject({state:'kpi_setting',closure:null});
  await owner.db.execute(sql`update employment set terminated_on=${today()}::date where id=${started}::uuid`);
  await sweepProbation(runner(),owner);
  expect(await caseOf(started)).toMatchObject({state:'withdrawn',closure:'exit'});
  const pending=await starter(addDaysIso(today(),20));
  await owner.db.execute(sql`update employment set import_pending_attempt_id=${randomUUID()}::uuid where id=${pending}::uuid`);
  await sweepProbation(runner(),owner);
  expect(await caseOf(pending)).toBeNull();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_did_not_join(${randomUUID()}::uuid)`))).rejects.toThrow();
 });
});

describe('intake and activation by company',()=>{
 it('compares full-time Personnel Probation with open cases as the reviewer sees them',async()=>{
  const[hr]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional intake People Ops',${randomUUID()+'@activation.example.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${hr.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hr.id};
  await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people'})}::jsonb)`);
 await saveBusinessPartners([]);
  await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:[{id:'probation-people',name:'Canonical People Ops',members:[admin.userId],limit:10}]})}::jsonb)`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Intake People Ops fixture')`);
  const[initial]=await probationActivationCounts(admin,[b.companyId]);
  expect(initial).toMatchObject({companyId:b.companyId,openCases:0,live:true});
  const first=await starter(addDaysIso(today(),-20)),second=await starter(addDaysIso(today(),-10));
  await owner.db.execute(sql`update employment set probation_end_date=${addDaysIso(today(),150)}::date where id in(${first}::uuid,${second}::uuid)`);
  const confirmed=await starter(addDaysIso(today(),-300));
  await owner.db.execute(sql`update employment set confirmation_date=${addDaysIso(today(),-100)}::date,probation_end_date=${addDaysIso(today(),-100)}::date where id=${confirmed}::uuid`);
  const[before]=await probationActivationCounts(admin,[b.companyId]);
  expect(before).toMatchObject({personnelProbation:initial.personnelProbation+2,openCases:0});
  await sweepProbation(runner(),owner);
  const[after]=await probationActivationCounts(admin,[b.companyId]);
  expect(after).toMatchObject({personnelProbation:initial.personnelProbation+2,openCases:2,live:true});
  expect(await probationActivationCounts(admin,[])).toEqual([]);
 });
});
