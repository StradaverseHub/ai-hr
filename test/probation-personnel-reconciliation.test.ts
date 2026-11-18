/** Real owner worker + canonical admission, with fictional authorised fixtures only. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,saveProbationConfiguration,probationPersonnelDiscrepancies} from '../packs/probation/service';
import {runProbationReconciliationTick} from '../core/probation-reconciliation-worker';
import {createProbationCase} from '../lib/probation-model';
import type {ProbationPersonnel,ProbationSettings} from '../packs/probation/service';
import {probationBusinessUnitMissing} from '../lib/probation-reconciliation';
let b:Base,admin:SessionContext,grade:string;
const today=todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 grade=randomUUID();await owner.db.execute(sql`insert into job_grade(id,tenant_id,code,name) values(${grade}::uuid,${b.tenantId}::uuid,'JG17','Fictional grade seventeen')`);
});
async function publish(kind:'settings'|'form'|'route'){
 await saveProbationConfiguration(admin,{companyId:b.companyId,kind,data:kind==='settings'?DEFAULT_PROBATION_CONFIG:kind==='form'?DEFAULT_PROBATION_FORM:defaultProbationRoutes(),publish:true,expectedVersion:0});
}
async function activate(){await owner.db.execute(sql`insert into probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,true,${addDaysIso(today,-60)}::date,${'a'.repeat(64)},${admin.userId}::uuid)`);}
async function starter(start=addDaysIso(today,-1),gradeId=grade){
 const hired=await hireEmployee(admin,{person:{fullName:'Fictional reconciliation employee',primaryEmail:randomUUID()+'@reconciliation.example.test'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:start,gradeId});
 await owner.db.execute(sql`update employment set probation_value=6,probation_unit='month',probation_months=6,probation_end_date=${addDaysIso(start,181)}::date where id=${hired.employmentId}::uuid`);
 return hired.employmentId;
}
const read=()=>probationPersonnelDiscrepancies(admin,{companyId:b.companyId});
const tick=()=>runProbationReconciliationTick(owner.client,owner);
async function drain(){for(let n=0;n<40;n++){const[row]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_reconciliation_intent where retry_on<=now()`);if(n>1&&row.n===0)break;await tick();}}
async function cases(id:string){return owner.db.execute<{id:string;data:Record<string,unknown>}>(sql`select id,data from probation_case where employment_id=${id}::uuid`);}

describe('Personnel to probation reconciliation',()=>{
 it('aggregates every setup reason, warns for missing BU, and fixes them without any read writing',async()=>{
  const id=await starter();const first=await read();
  expect(first.rows.find(r=>r.employmentId===id)).toMatchObject({grade:'17',missingBusinessUnit:true,reasons:['settings','form','route','activation']});
  const[before]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_reconciliation_intent`);
  await read();await read();
  expect((await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_reconciliation_intent`))[0].n).toBe(before.n);
  await drain();expect(await cases(id)).toHaveLength(0);
  await publish('settings');await publish('form');await publish('route');await activate();
  await drain();
  const opened=await cases(id);expect(opened).toHaveLength(1);
  expect(opened[0].data).toMatchObject({employmentId:id,gradeAtStart:'17',startOn:addDaysIso(today,-1),facts:{businessUnitId:null,departmentId:b.deptA,companyId:b.companyId}});
  expect((await read()).rows.find(r=>r.employmentId===id)).toBeUndefined();
  await drain();expect(await cases(id)).toEqual(opened);
 });
 it('queues status changes, admits before-start records with a missing BU, and never issues work early',async()=>{
  await publish('settings');await publish('form');await publish('route');await activate();
  const start=addDaysIso(today,10),id=await starter(start);
  const[intent]=await owner.db.execute<{revision:string}>(sql`select revision::text from probation_reconciliation_intent where employment_id=${id}::uuid`);expect(Number(intent.revision)).toBeGreaterThan(1);
  await drain();const opened=await cases(id);expect(opened).toHaveLength(1);
  const parts=await owner.db.execute<{state:string}>(sql`select data->>'state' as state from probation_part where case_id=${opened[0].id}::uuid`);
  expect(parts.length).toBeGreaterThanOrEqual(2);expect(new Set(parts.map(p=>p.state))).toEqual(new Set(['not_issued']));
  expect((await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_occurrence where case_id=${opened[0].id}::uuid`))[0].n).toBe(0);
  // Native profile activation updates the same employment record; no special caller hook is needed.
  await owner.db.execute(sql`update employment set probation_value=6 where id=${id}::uuid`);
  await Promise.all([tick(),tick()]);await drain();expect(await cases(id)).toEqual(opened);
 });
 it('names grade exclusions and closed-case/cutover holds while retaining published versions',async()=>{
  await publish('settings');await publish('form');await publish('route');await activate();
  const old=await starter(addDaysIso(today,-90));
  expect((await read()).rows.find(r=>r.employmentId===old)?.reasons).toContain('cutover');
  const ineligible=randomUUID();await owner.db.execute(sql`insert into job_grade(id,tenant_id,code,name) values(${ineligible}::uuid,${b.tenantId}::uuid,'JG9','Fictional grade nine')`);
  const id=await starter(addDaysIso(today,-1),ineligible);
  const row=(await read()).rows.find(r=>r.employmentId===id)!;expect(row.grade).toBe('9');expect(row.reasons).toContain('grade_ineligible');expect(row.reasons).toContain('form');
  await drain();expect(await cases(old)).toHaveLength(0);expect(await cases(id)).toHaveLength(0);
 });
 it('recovers only the exact applied reviewed cutover import and retains its stage/version identity',async()=>{
  await publish('settings');await publish('form');await publish('route');await activate();
  const id=await starter();await owner.db.execute(sql`update probation_activation set activation_on=${today}::date where tenant_id=${b.tenantId}::uuid`);
  expect((await read()).rows.find(r=>r.employmentId===id)?.reasons).toContain('cutover');await drain();expect(await cases(id)).toHaveLength(0);
  // Fictional persisted activation-recovery fixture. These are actual canonical source/version values,
  // not a shortcut around the admission checks being exercised by the worker below.
  const[hr]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional reconciliation People Ops',${randomUUID()+'@reconciliation.example.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${hr.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hr.id};
  await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'reconciliation-ops',bpRules:[]})}::jsonb)`);
  await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:[{id:'reconciliation-ops',name:'Fictional People Ops',members:[admin.userId],limit:10}]})}::jsonb)`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2020-01-01','Fictional current intake reviewer')`);
  const runner={tenantId:b.tenantId,roles:[],grants:[]} as SessionContext;
  const[source]=await owner.withTenant(runner,tx=>tx.execute<{data:ProbationPersonnel;digest:string}>(sql`select app.probation_personnel_source(${id}::uuid) as data,app.probation_intake_digest(${id}::uuid) as digest`));
  const versions=await owner.db.execute<{id:string;kind:string;data:ProbationSettings}>(sql`select id,kind,data from probation_configuration where tenant_id=${b.tenantId}::uuid and company_id=${b.companyId}::uuid and state='published'`);
  const settings=versions.find(v=>v.kind==='settings')!;
  const record=createProbationCase({id:randomUUID(),employmentId:id,companyId:b.companyId,sourceKey:'employment:'+id,startOn:source.data.startOn,endOn:source.data.endOn,months:6,grade:'17',explicitNoProbation:false,config:settings.data,nextId:randomUUID,isWorking:()=>true})!;
  const entryId=randomUUID(),batchId=randomUUID(),digest='b'.repeat(64),parts=record.parts.map(part=>({type:part.type,cycle:part.cycle,status:'unfinished',evidenceId:null}));
  await owner.db.execute(sql`insert into probation_intake_entry(id,tenant_id,company_id,employment_id,source_digest,data,reviewed_by) values(${entryId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${id}::uuid,${source.digest},${JSON.stringify({kind:'unfinished',reason:'Fictional reviewed recovery',parts})}::jsonb,${admin.userId}::uuid)`);
  const imported={employmentId:id,entryId,entryRevision:1,sourceDigest:source.digest,record,milestones:{},settingsId:settings.id,formId:versions.find(v=>v.kind==='form')!.id,routeId:versions.find(v=>v.kind==='route')!.id};
  await owner.db.execute(sql`insert into probation_cutover(id,tenant_id,company_id,data,digest,actor_user_id,approved_by,approved_at,applied_at,reason) values(${batchId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${JSON.stringify({planComplete:true,activationOn:today,imports:[imported]})}::jsonb,${digest},${admin.userId}::uuid,${admin.userId}::uuid,now(),now(),'Fictional exact reviewed recovery')`);
  await owner.db.execute(sql`update probation_activation set dry_run_digest=${digest} where tenant_id=${b.tenantId}::uuid`);
  expect((await read()).rows.find(r=>r.employmentId===id)?.reasons).not.toContain('cutover');
  await drain();const opened=await cases(id);expect(opened).toHaveLength(1);expect(opened[0].id).toBe(record.id);expect(opened[0].data.cutoverBatchId).toBe(batchId);
  expect((await owner.db.execute<{applied_case_id:string}>(sql`select applied_case_id from probation_intake_entry where id=${entryId}::uuid`))[0].applied_case_id).toBe(record.id);
  await drain();expect((await cases(id))[0].id).toBe(record.id);
 });
 it('records a successful empty pass without inventing a checked timestamp for queued work',async()=>{
  // The base includes employed personas. Give them an independently ineligible status;
  // deleting their intents alone would let the catch-up scan correctly queue them again.
  await owner.db.execute(sql`update employment set confirmation_date=${today}::date where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`delete from probation_reconciliation_intent where tenant_id=${b.tenantId}::uuid`);
  expect((await owner.db.execute<{n:number}>(sql`select count(*)::integer n from employment where tenant_id=${b.tenantId}::uuid and confirmation_date is null`))[0].n).toBe(0);
  // The reserved auth-audit tenant is also scanned. Drive the bounded worker to idle,
  // rather than assuming this business tenant wins the first scheduling tick.
  await drain();
  const[empty]=await owner.db.execute<{last_success_at:unknown}>(sql`select last_success_at from probation_reconciliation_schedule where tenant_id=${b.tenantId}::uuid`);expect(empty.last_success_at).toBeTruthy();
  await starter();await owner.db.execute(sql`update probation_reconciliation_schedule set next_check_at=now(),last_success_at=null where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`select app.probation_reconciliation_schedule_tick()`);
  const[queued]=await owner.db.execute<{last_success_at:unknown}>(sql`select last_success_at from probation_reconciliation_schedule where tenant_id=${b.tenantId}::uuid`);expect(queued.last_success_at).toBeNull();
  const[scanned]=await owner.db.execute<{pass_count:string}>(sql`select pass_count::text from probation_reconciliation_schedule where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`update probation_reconciliation_schedule set next_check_at=now() where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`select app.probation_reconciliation_schedule_tick()`);
  expect((await owner.db.execute<{pass_count:string}>(sql`select pass_count::text from probation_reconciliation_schedule where tenant_id=${b.tenantId}::uuid`))[0].pass_count).toBe(scanned.pass_count);
  await drain();expect((await read()).lastSuccessfulCheck).toBeTruthy();
 });
 it('does not scan or claim a successful pass for a suspended tenant',async()=>{
  await owner.db.execute(sql`delete from probation_reconciliation_intent where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`insert into probation_reconciliation_schedule(tenant_id) values(${b.tenantId}::uuid) on conflict(tenant_id) do update set next_check_at=now(),last_success_at=null`);
  await owner.db.execute(sql`update tenant set status='suspended' where id=${b.tenantId}::uuid`);
  await tick();
  const[state]=await owner.db.execute<{last_success_at:unknown;pass_count:string}>(sql`select last_success_at,pass_count::text from probation_reconciliation_schedule where tenant_id=${b.tenantId}::uuid`);
  expect(state).toEqual({last_success_at:null,pass_count:'0'});
 });
 it('refuses application-role worker/admission escalation and crosses no tenant boundary',async()=>{
  await starter();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_reconciliation_schedule_tick()`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select * from probation_reconciliation_intent`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select * from app.probation_reconciliation_population(null,null)`))).rejects.toThrow();
  const other=await seedBase();await setModule(other.tenantId,'lifecycle','active');
  expect((await probationPersonnelDiscrepancies(adminCtx(other))).rows.map(r=>r.companyId)).not.toContain(b.companyId);
 });
 it('warns on the actual PM BU identity under both organisation mappings',()=>{
  expect(probationBusinessUnitMissing({businessGroupId:b.companyId,businessUnitId:null})).toBe(true);
  expect(probationBusinessUnitMissing({organisationMapping:'personnel-v2',businessGroupId:null,businessUnitId:b.companyId})).toBe(true);
  expect(probationBusinessUnitMissing({organisationMapping:'personnel-v2',businessGroupId:'pm-unit',businessUnitId:b.companyId})).toBe(false);
 });
});
