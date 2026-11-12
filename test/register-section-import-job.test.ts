/** Register and section imports as background jobs on the shared bulk-job kernel: real PostgreSQL, real RLS, real
 * worker ticks. Equivalence is proven against the synchronous path on an identical second tenant: the same rows, the
 * same audit events in the same order, the same result and the same history row. The one difference the hardened
 * kernel adds is asserted on its own: the events the register release writes on the owner connection carry their job
 * (payload.bulkJob, migration 5014). */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {commitSectionImport} from '../core/import-sections';
import {createSectionImportJob,getSectionImportJob} from '../core/section-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {requestBulkJobCancel} from '../core/bulk-job';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {hireEmployee} from '../core/org';
import {createProfileOption} from '../core/profile-options';
import {updateQualification} from '../core/workforce-registers';
import {verifyTenantChain} from '../core/audit-chain';
import {SECTION_IMPORT_ALREADY_RUNNING} from '../lib/section-import-job';
import type {ImportRecord} from '../lib/import-schema';
import type {SectionImportResult} from '../lib/import-sections';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

// One employee per chunk, so failures and concurrent edits land between committed chunks; the audit chain armed.
vi.hoisted(()=>{process.env.REGISTER_IMPORT_CHUNK_BUDGET_MS='1';process.env.SECTION_IMPORT_CHUNK_BUDGET_MS='1';process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
beforeAll(migrateTestDb);
beforeEach(resetDb);
afterAll(closeAll);

const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const CODES=['REG0','REG1','REG2','REG3'];
type Fixture={b:Base;ctx:SessionContext;employments:Record<string,string>;persons:Record<string,string>};
/** Four employees, each with one live Highest qualification and one Primary contact, written by the synchronous path. */
async function fixture():Promise<Fixture>{
 const b=await seedBase(),ctx=adminCtx(b);
 for(const value of ['Diploma','Bachelor','Master'])await createProfileOption(ctx,{category:'qualificationLevel',value,label:value}).catch(()=>undefined);
 const employments:Record<string,string>={},persons:Record<string,string>={};
 for(const [i,code] of CODES.entries()){
  const hired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-100),employeeCode:code,
   person:{fullName:`Fictional Register ${i}`,primaryEmail:`register-${i}-${b.tenantId.slice(0,8)}@fixture.test`}});
  employments[code]=hired.employmentId;persons[code]=hired.personId;
 }
 const q=await commitSectionImport(ctx,{section:'qualification',records:CODES.map((code,i)=>({employee_code:code,qualification:'Diploma',institute:`Old institute ${i}`,is_highest:'Yes'}))});
 const e=await commitSectionImport(ctx,{section:'emergency',records:CODES.map((code,i)=>({employee_code:code,full_name:`Old contact ${i}`,relationship:'Spouse',priority:'primary'}))});
 expect([q.updated,e.updated]).toEqual([4,4]);
 return{b,ctx,employments,persons};
}
const recordId=async(f:Fixture,kind:'qualification'|'emergency',code:string)=>{
 const rows=kind==='qualification'
  ?await owner.client<{id:string}[]>`select id from employee_qualification where employment_id=${f.employments[code]}::uuid order by created_at,id limit 1`
  :await owner.client<{id:string}[]>`select id from person_emergency_contact where person_id=${f.persons[code]}::uuid order by created_at,id limit 1`;
 return rows[0].id;
};
const qualificationFile=async(f:Fixture):Promise<ImportRecord[]>=>[
 {employee_code:'REG0',record_id:await recordId(f,'qualification','REG0'),qualification:'',institute:'Renamed institute 0',from_ym:'',to_ym:'',graduation_date:'',major:'',result:'',description:'',is_highest:''},
 {employee_code:'REG0',record_id:'',qualification:'Master',institute:'New institute 0',from_ym:'2019-01',to_ym:'2020-12',graduation_date:'',major:'Fictional major',result:'',description:'',is_highest:'Yes'},
 {employee_code:'REG1',record_id:'',qualification:'Bachelor',institute:'New institute 1',from_ym:'',to_ym:'',graduation_date:'',major:'',result:'',description:'',is_highest:''},
 {employee_code:'REG2',record_id:await recordId(f,'qualification','REG2'),qualification:'',institute:'',from_ym:'',to_ym:'',graduation_date:'',major:'Updated major 2',result:'',description:'',is_highest:''},
 {employee_code:'REG3',record_id:'',qualification:'Bachelor',institute:'New institute 3a',from_ym:'',to_ym:'',graduation_date:'',major:'',result:'',description:'',is_highest:''},
 {employee_code:'REG3',record_id:'',qualification:'Master',institute:'New institute 3b',from_ym:'',to_ym:'',graduation_date:'',major:'',result:'',description:'',is_highest:'Yes'},
];
const emergencyFile=async(f:Fixture):Promise<ImportRecord[]>=>[
 {employee_code:'REG0',record_id:'',full_name:'New primary 0',relationship:'Parent',mobile_phone:'0120000000',home_phone:'',priority:'primary',address:'',remarks:''},
 {employee_code:'REG1',record_id:await recordId(f,'emergency','REG1'),full_name:'',relationship:'',mobile_phone:'0121111111',home_phone:'',priority:'',address:'',remarks:''},
 {employee_code:'REG2',record_id:'',full_name:'Second contact 2',relationship:'Sibling',mobile_phone:'',home_phone:'',priority:'secondary',address:'',remarks:''},
];
const csvOf=(records:ImportRecord[])=>[Object.keys(records[0]).join(','),...records.map(r=>Object.values(r).join(','))].join('\n');
const tick=()=>runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});
type JobState={id:string;state:string;plan:Record<string,unknown>|null;metrics:Record<string,number>;notified_at:Date|null;steps_done:number;steps_total:number};
const jobState=async(id:string)=>(await owner.client<JobState[]>`select id,state,plan,metrics,notified_at,steps_done,steps_total from bulk_job where id=${id}::uuid`)[0];
async function ticks(id:string,stop:(job:JobState)=>boolean=j=>['completed','failed','cancelled'].includes(j.state)&&j.notified_at!==null,max=400){
 for(let i=0;i<max;i++){
  const job=await jobState(id);
  if(stop(job))return job;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,40));
 }
 throw new Error('job did not reach the expected state');
}
async function runJob(f:Fixture,section:string,records:ImportRecord[],fileName='Fixture · records.csv'){
 const {job}=await createSectionImportJob(f.ctx,{section,records,fileName,csv:csvOf(records),operationKey:randomUUID()});
 await ticks(job.id);
 return getSectionImportJob(f.ctx,job.id);
}
/** Everything the import may have changed, with identities replaced by stable labels (ids and timestamps differ). */
async function endState(f:Fixture){
 const code=new Map([...Object.entries(f.employments).map(([c,id])=>[id,c] as const),...Object.entries(f.persons).map(([c,id])=>[id,c] as const)]);
 const quals=await owner.client<Record<string,unknown>[]>`select q.id,q.employment_id,q.qualification,q.institute,q.major,q.from_ym,q.to_ym,q.is_highest,q.archived_at is not null as archived
  from employee_qualification q where q.tenant_id=${f.b.tenantId}::uuid`;
 const contacts=await owner.client<Record<string,unknown>[]>`select c.id,c.person_id,c.full_name,c.relationship,c.mobile_phone,c.priority,c.archived_at is not null as archived
  from person_emergency_contact c where c.tenant_id=${f.b.tenantId}::uuid`;
 const label=new Map<string,string>();
 for(const q of quals)label.set(String(q.id),`q:${code.get(String(q.employment_id))}:${q.institute}`);
 for(const c of contacts)label.set(String(c.id),`c:${code.get(String(c.person_id))}:${c.full_name}`);
 const relabel=(value:unknown):unknown=>typeof value==='string'?(label.get(value)??code.get(value)??value):Array.isArray(value)?value.map(relabel):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,relabel(v)])):value;
 const events=await owner.client<Record<string,unknown>[]>`select aggregate_type,aggregate_id,event_type,actor_type,actor_id=${f.ctx.userId!}::uuid as by_admin,subject_employment_id,payload,import_pending_attempt_id is null as visible
  from domain_event where tenant_id=${f.b.tenantId}::uuid and aggregate_type in ('employee-qualification','person-emergency-contact') order by sequence`;
 const runs=await owner.client<Record<string,unknown>[]>`select file_name,total_rows,imported_rows,failed_rows,errors,errors_truncated,created_by_user_id::text=${f.ctx.userId!} as by_admin from employee_import_run where tenant_id=${f.b.tenantId}::uuid order by created_at`;
 const strip=({id:_id,employment_id,person_id,...rest}:Record<string,unknown>)=>({who:code.get(String(employment_id??person_id)),...rest});
 return{
  qualifications:quals.map(strip).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  contacts:contacts.map(strip).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  events:events.map(e=>relabel({...e,payload:withoutJob(e.payload)})),runs,
 };
}
/** Owner-path events carry their job (5014). endState leaves that key out so the rest compares with the synchronous
 * path; eventJobs reports it for every register event, in order (null: written outside an owner transaction). */
const withoutJob=(payload:unknown)=>{
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return payload;
 const {bulkJob:_bulkJob,...rest}=payload as Record<string,unknown>;return rest;
};
async function eventJobs(f:Fixture){
 return(await owner.client<{job:{id:string;kind:string}|null}[]>`select payload->'bulkJob' as job from domain_event
  where tenant_id=${f.b.tenantId}::uuid and aggregate_type in ('employee-qualification','person-emergency-contact') order by sequence`).map(e=>e.job);
}
/** The seal recomputed over the job's stored steps, as only the queue owner can (the application role cannot write the
 * job store, 5013). Without it the kernel's integrity check stops a changed step before the release ever runs; with
 * it the release has to refuse the forged capture on its own checks. */
async function resealSteps(jobId:string){
 await owner.client`update app.bulk_job_step_seal z set digest=app.bulk_job_step_digest(s.kind,s.row_num,s.payload,s.state,s.result,s.error)
  from bulk_job_step s where s.job_id=z.job_id and s.seq=z.seq and z.job_id=${jobId}::uuid`;
}
const comparable=(r:SectionImportResult)=>({...r,runId:r.runId?'run':null});

describe('register import job (all-or-nothing)',()=>{
 it('produces exactly the synchronous end state for qualifications: rows, events in file order, result and history',async()=>{
  const sync=await fixture(),job=await fixture();
  const expected=await commitSectionImport(sync.ctx,{section:'qualification',records:await qualificationFile(sync),fileName:'Fixture · records.csv'});
  expect(expected).toMatchObject({updated:6,fileErrors:[]});
  const before=await endState(job);
  const {job:started}=await createSectionImportJob(job.ctx,{section:'qualification',records:await qualificationFile(job),fileName:'Fixture · records.csv',csv:'x',operationKey:randomUUID()});
  // Until the release nothing is visible: every chunk's writes were captured and rolled back.
  await ticks(started.id,j=>j.state==='finalizing');
  expect(await endState(job)).toEqual(before);
  await ticks(started.id);
  const progress=await getSectionImportJob(job.ctx,started.id);
  expect(progress.state).toBe('completed');
  expect(comparable(progress.result!)).toEqual(comparable(expected));
  const after=await endState(job);
  expect(after).toEqual(await endState(sync));
  // Independent expectations, so equality cannot pass on two empty states: the six writes, in file order.
  expect(after.events.slice(-6).map(e=>[(e as {event_type:string}).event_type,(e as {subject_employment_id:string}).subject_employment_id,(e as {visible:boolean}).visible])).toEqual([
   ['qualification.updated','REG0',true],['qualification.added','REG0',true],['qualification.added','REG1',true],['qualification.updated','REG2',true],['qualification.added','REG3',true],['qualification.added','REG3',true]]);
  expect((after.events.at(-5) as {payload:unknown}).payload).toEqual({qualification:'Master',isHighest:true,clearedHighestId:'q:REG0:Renamed institute 0'});
  // The release's six events, and only they, carry the job that wrote them on the owner connection.
  const attributed=await eventJobs(job);
  expect(attributed.slice(-6)).toEqual(Array.from({length:6},()=>({id:started.id,kind:'register_import'})));
  expect(attributed.slice(0,-6).length).toBeGreaterThan(0);
  expect(attributed.slice(0,-6).every(j=>j===null)).toBe(true);
  expect((await eventJobs(sync)).every(j=>j===null)).toBe(true);
  expect(after.qualifications.filter(q=>q.who==='REG0')).toEqual([
   {who:'REG0',qualification:'Diploma',institute:'Renamed institute 0',major:null,from_ym:null,to_ym:null,is_highest:false,archived:false},
   {who:'REG0',qualification:'Master',institute:'New institute 0',major:'Fictional major',from_ym:'2019-01',to_ym:'2020-12',is_highest:true,archived:false}]);
  expect(after.runs.at(-1)).toMatchObject({file_name:'Fixture · records.csv',total_rows:6,imported_rows:6,failed_rows:0,by_admin:true});
  const [metrics]=await owner.client<{metrics:Record<string,number>}[]>`select metrics from bulk_job where id=${started.id}::uuid`;
  expect(metrics.metrics.releaseTxMs).toBeGreaterThan(0);
  expect((await verifyTenantChain(job.ctx)).valid).toBe(true);
  // One creator-authored completion notice.
  const notices=await owner.client<{payload:{kind:string;outcome:string}}[]>`select payload from domain_event where aggregate_type='bulk-job' and aggregate_id=${started.id}::uuid`;
  expect(notices.map(n=>n.payload)).toEqual([{kind:'register_import',outcome:'completed'}]);
 });

 it('produces exactly the synchronous end state for emergency contacts, including the Primary demotion',async()=>{
  const sync=await fixture(),job=await fixture();
  const expected=await commitSectionImport(sync.ctx,{section:'emergency',records:await emergencyFile(sync),fileName:'Fixture · contacts.csv'});
  const progress=await runJob(job,'emergency',await emergencyFile(job),'Fixture · contacts.csv');
  expect(comparable(progress.result!)).toEqual(comparable(expected));
  expect(await endState(job)).toEqual(await endState(sync));
  expect((await eventJobs(job)).slice(-3)).toEqual(Array.from({length:3},()=>({id:progress.id,kind:'register_import'})));
 });

 it('refuses an invalid file with the synchronous file error and writes nothing',async()=>{
  const sync=await fixture(),job=await fixture();
  const bad=(records:ImportRecord[])=>records.map((r,i)=>i===2?{...r,qualification:'Not a catalogue value'}:r);
  const expected=await commitSectionImport(sync.ctx,{section:'qualification',records:bad(await qualificationFile(sync))});
  expect(expected.fileErrors).toEqual(['Correct all register rows before importing. Nothing from this register file will be written.']);
  const before=await endState(job);
  const progress=await runJob(job,'qualification',bad(await qualificationFile(job)));
  expect(progress.state).toBe('failed');
  expect(comparable(progress.result!)).toEqual(comparable(expected));
  expect(await endState(job)).toEqual(before);
 });

 it('leaves nothing behind when a later employee is refused at write time, with the synchronous message shape',async()=>{
  const job=await fixture();
  await owner.client.unsafe(`create or replace function public.register_fixture_refuse() returns trigger language plpgsql as $$ begin
   if new.institute='New institute 3b' then raise exception 'fixture refusal' using errcode='P0001'; end if; return new; end $$`);
  await owner.client.unsafe('create trigger register_fixture_refuse before insert on employee_qualification for each row execute function public.register_fixture_refuse()');
  try{
   const before=await endState(job);
   const progress=await runJob(job,'qualification',await qualificationFile(job));
   expect(progress.state).toBe('failed');
   expect(progress.result).toMatchObject({updated:0,skipped:6,failed:[],runId:null});
   expect(progress.result!.fileErrors).toHaveLength(1);
   expect(progress.result!.fileErrors[0]).toMatch(/^No register rows were written\. This change was refused by a safeguard/);
   expect(await endState(job)).toEqual(before);
  }finally{
   await owner.client.unsafe('drop trigger if exists register_fixture_refuse on employee_qualification');
   await owner.client.unsafe('drop function if exists public.register_fixture_refuse()');
  }
 });

 it('captures again an employee whose register changed after capture, keeping both the other edit and the import',async()=>{
  const job=await fixture();
  const records=await qualificationFile(job);
  const {job:started}=await createSectionImportJob(job.ctx,{section:'qualification',records,fileName:'f.csv',csv:'x',operationKey:randomUUID()});
  await ticks(started.id,j=>j.state==='finalizing');
  // Another administrator edits REG2's qualification between its capture and the release.
  await updateQualification(job.ctx,{id:await recordId(job,'qualification','REG2'),result:'Concurrent result'});
  await ticks(started.id);
  const done=await jobState(started.id);
  expect(done.state).toBe('completed');expect(done.plan).toMatchObject({rounds:1,released:true,updated:6});
  expect(done.metrics.recaptured).toBe(1);
  const [reg2]=await owner.client<{result:string|null;major:string|null}[]>`select result,major from employee_qualification where id=${await recordId(job,'qualification','REG2')}::uuid`;
  expect(reg2).toEqual({result:'Concurrent result',major:'Updated major 2'});
 });

 it('stops with nothing written when an employee resigns between capture and release',async()=>{
  const job=await fixture();
  const before=await endState(job);
  const {job:started}=await createSectionImportJob(job.ctx,{section:'qualification',records:await qualificationFile(job),fileName:'f.csv',csv:'x',operationKey:randomUUID()});
  await ticks(started.id,j=>j.state==='finalizing');
  await owner.client`update employment set terminated_on=current_date-1 where id=${job.employments.REG1}::uuid`;
  await ticks(started.id);
  const progress=await getSectionImportJob(job.ctx,started.id);
  expect(progress.state).toBe('failed');
  expect(progress.result!.fileErrors).toEqual(['Correct all register rows before importing. Nothing from this register file will be written.']);
  expect((await endState(job)).qualifications).toEqual(before.qualifications);
 });

 it('refuses a capture that names another employee\'s record, and keeps the release owner-only',async()=>{
  const job=await fixture();
  const before=await endState(job);
  const {job:started}=await createSectionImportJob(job.ctx,{section:'qualification',records:await qualificationFile(job),fileName:'f.csv',csv:'x',operationKey:randomUUID()});
  await ticks(started.id,j=>j.state==='finalizing');
  // A tampered capture: a new row re-pointed at another employee, resealed so the release itself must refuse it.
  await owner.client`update bulk_job_step set result=jsonb_set(result,'{created,0,employment_id}',to_jsonb(${job.employments.REG2}::text)) where job_id=${started.id}::uuid and result->'created'->0 is not null and seq=(select min(seq) from bulk_job_step where job_id=${started.id}::uuid and jsonb_array_length(result->'created')>0)`;
  await resealSteps(started.id);
  await expect(withTenant(job.ctx,tx=>tx.execute(sql`select app.register_import_release(${started.id}::uuid,false)`))).rejects.toThrow();
  await ticks(started.id);
  const progress=await getSectionImportJob(job.ctx,started.id);
  expect(progress.state).toBe('failed');
  expect(progress.result!.fileErrors[0]).toMatch(/^No register rows were written\./);
  expect(await endState(job)).toEqual(before);
 });

describe('register release trusts nothing in the job\'s steps for authority',()=>{
 /** Runs a qualification job to its release with `forge` rewriting the first applied capture. The application role can
  * no longer write a step (5013) and an unsealed change is stopped by the kernel's integrity check, so the forgery is
  * resealed as the queue owner could: the release must still refuse it on its own. */
 async function forged(f:Fixture,forge:(capture:Record<string,unknown>)=>Record<string,unknown>,as:SessionContext=f.ctx){
  const before=await endState(f);
  const {job:started}=await createSectionImportJob(as,{section:'qualification',records:await qualificationFile(f),fileName:'f.csv',csv:'x',operationKey:randomUUID()});
  await ticks(started.id,j=>j.state==='finalizing');
  const [step]=await owner.client<{seq:number;result:Record<string,unknown>}[]>`select seq,result from bulk_job_step where job_id=${started.id}::uuid and state='applied' order by seq limit 1`;
  await owner.client`update bulk_job_step set result=${JSON.stringify(forge(step.result))}::jsonb where job_id=${started.id}::uuid and seq=${step.seq}`;
  await resealSteps(started.id);
  await ticks(started.id);
  const progress=await getSectionImportJob(as,started.id);
  expect(progress.state).toBe('failed');
  expect(progress.result!.fileErrors[0]).toMatch(/^No register rows were written\./);
  return{before,after:await endState(f)};
 }
 const pointAt=(employmentId:string,personId:string,code:string)=>(c:Record<string,unknown>)=>({...c,key:employmentId,subjects:[{code,employmentId,personId}]});
 it('refuses a capture with no subjects',async()=>{
  const f=await fixture();
  const {before,after}=await forged(f,c=>({...c,subjects:[]}));
  expect(after).toEqual(before);
 });
 it('refuses a capture whose key is an employee outside the creator\'s companies',async()=>{
  const f=await fixture();
  // A second company of the same tenant, and an administrator scoped to the first company only.
  const [other]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) values(${f.b.tenantId}::uuid,'Fictional Other Sdn Bhd') returning id`;
  const [dept]=await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name) values(${f.b.tenantId}::uuid,${other.id}::uuid,'Fictional Other Dept') returning id`;
  const outside=await hireEmployee(f.ctx,{companyId:other.id,departmentId:dept.id,employmentType:'full_time',hiredOn:day(-100),employeeCode:'OUT1',person:{fullName:'Fictional Outside',primaryEmail:`outside-${f.b.tenantId.slice(0,8)}@fixture.test`}});
  const [person]=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional Scoped Admin',${`scoped-${f.b.tenantId.slice(0,8)}@fixture.test`}) returning id`;
  const userId=await createAppUser(f.b.tenantId,person.id,'hr_admin');
  await owner.client`update role_assignment set company_id=${f.b.companyId}::uuid where app_user_id=${userId}::uuid`;
  const scoped={...f.ctx,userId,personId:person.id,grants:[{role:'hr_admin',companyId:f.b.companyId}],roles:['hr_admin']} as SessionContext;
  const outsideRows=async()=>(await owner.client`select id from employee_qualification where employment_id=${outside.employmentId}::uuid`).length;
  const {before,after}=await forged(f,pointAt(outside.employmentId,outside.personId,'OUT1'),scoped);
  expect(after.qualifications).toEqual(before.qualifications);
  expect(await outsideRows()).toBe(0);
 });
 it('refuses a capture once the creator is explicitly denied workforce maintain for the company',async()=>{
  const f=await fixture();
  const {job:started}=await createSectionImportJob(f.ctx,{section:'qualification',records:await qualificationFile(f),fileName:'f.csv',csv:'x',operationKey:randomUUID()});
  await ticks(started.id,j=>j.state==='finalizing');
  const before=await endState(f);
  await owner.client`update access_capability set supported=true where id='workforce.maintain'`;
  try{
   await owner.client`insert into access_configuration(tenant_id,initialized) values(${f.b.tenantId}::uuid,true) on conflict(tenant_id) do update set initialized=true`;
   await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${f.b.tenantId}::uuid,${f.ctx.userId!}::uuid,'workforce.maintain',${f.b.companyId}::uuid,'deny')`;
   const denied=await withTenant(f.ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.access_workforce_company(${f.b.companyId}::uuid,'workforce.maintain') as ok`));
   expect(denied[0].ok).toBe(false);
   await ticks(started.id);
   const progress=await getSectionImportJob(f.ctx,started.id);
   expect(progress.state).toBe('failed');
   expect(progress.result!.fileErrors[0]).toMatch(/^No register rows were written\./);
   expect((await endState(f)).qualifications).toEqual(before.qualifications);
  }finally{await owner.client`update access_capability set supported=false where id='workforce.maintain'`;}
 });
 it('refuses a capture whose key is another tenant\'s employment',async()=>{
  const f=await fixture(),other=await fixture();
  const otherBefore=await endState(other);
  const {before,after}=await forged(f,pointAt(other.employments.REG0,other.persons.REG0,'REG0'));
  expect(after).toEqual(before);
  expect(await endState(other)).toEqual(otherBefore);
  expect((await owner.client`select id from employee_qualification where tenant_id=${f.b.tenantId}::uuid and employment_id=${other.employments.REG0}::uuid`)).toHaveLength(0);
 });
 it('refuses a capture that adds a row without its own audit event',async()=>{
  const f=await fixture();
  const {before,after}=await forged(f,c=>{
   const created=c.created as Record<string,unknown>[];
   const events=(c.events as {eventType:string;aggregateId:string}[]);
   const extra={...(created[0]??{}),id:randomUUID(),institute:'Forged extra row'};
   return{...c,created:[...created,extra],events};
  });
  expect(after).toEqual(before);
 });
 it('refuses a capture that changes a column its audit event does not name',async()=>{
  const f=await fixture();
  const {before,after}=await forged(f,c=>{
   const changed=c.changed as {id:string;set:Record<string,unknown>}[];
   if(!changed.length)throw new Error('fixture: the first capture changes an existing row');
   return{...c,changed:[{...changed[0],set:{...changed[0].set,major:'Forged silent change'}},...changed.slice(1)]};
  });
  expect(after).toEqual(before);
 });
});

 it('admits one register import per person at a time and refuses a non-administrator at the door',async()=>{
  const job=await fixture();
  await createSectionImportJob(job.ctx,{section:'qualification',records:await qualificationFile(job),fileName:'a.csv',csv:'x'});
  await expect(createSectionImportJob(job.ctx,{section:'emergency',records:await emergencyFile(job),fileName:'b.csv',csv:'x'})).rejects.toThrow(SECTION_IMPORT_ALREADY_RUNNING);
  const userId=await createAppUser(job.b.tenantId,null,'employee');
  const employee:SessionContext={tenantId:job.b.tenantId,userId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext;
  await expect(createSectionImportJob(employee,{section:'qualification',records:await qualificationFile(job),fileName:'c.csv',csv:'x'})).rejects.toThrow();
 });

 it('refuses an oversized register file before admitting a job, in the synchronous words',async()=>{
  const job=await fixture();
  const records=Array.from({length:501},()=>({employee_code:'REG0',qualification:'Diploma'}));
  await expect(createSectionImportJob(job.ctx,{section:'qualification',records,fileName:'big.csv',csv:'x'})).rejects.toThrow('A register import supports at most 500 rows. Split the file and check each part.');
  expect(await owner.client`select id from bulk_job`).toHaveLength(0);
 });
});

describe('section import job (one row per step)',()=>{
 const profileFile=(fail:string|null=null)=>[
  {employee_code:'REG0',phone:'0130000000'},
  {employee_code:'REG1',phone:'0131111111'},
  {employee_code:'NOBODY',phone:'0139999999'},
  {employee_code:'REG2',phone:fail??'0132222222'},
  {employee_code:'REG3',phone:''},
 ];
 it('produces exactly the synchronous result, refused rows, history and audit for a Profile file',async()=>{
  const sync=await fixture(),job=await fixture();
  // A database refusal of one row's write: the row fails on its own, the others are saved.
  await owner.client.unsafe(`create or replace function public.section_fixture_refuse() returns trigger language plpgsql as $$ begin
   if new.phone='0132222299' then raise exception 'fixture refusal' using errcode='P0001'; end if; return new; end $$`);
  await owner.client.unsafe('create trigger section_fixture_refuse before update on person for each row execute function public.section_fixture_refuse()');
  try{
   const expected=await commitSectionImport(sync.ctx,{section:'profile',records:profileFile('0132222299'),fileName:'Profile · p.csv'});
   expect(expected).toMatchObject({updated:2,failed:[{rowNum:4,employeeCode:'REG2'}]});
   const progress=await runJob(job,'profile',profileFile('0132222299'),'Profile · p.csv');
   expect(progress.state).toBe('completed');
   expect(comparable(progress.result!)).toEqual(comparable(expected));
   const phones=async(f:Fixture)=>(await owner.client<{phone:string|null;full_name:string}[]>`select phone,full_name from person where tenant_id=${f.b.tenantId}::uuid and full_name like 'Fictional Register%' order by full_name`).map(r=>r.phone);
   expect(await phones(job)).toEqual(await phones(sync));
   const personEvents=async(f:Fixture)=>(await owner.client<{event_type:string;payload:unknown}[]>`select event_type,payload from domain_event where tenant_id=${f.b.tenantId}::uuid and aggregate_type='person' order by sequence`).map(e=>e.event_type);
   expect(await personEvents(job)).toEqual(await personEvents(sync));
   expect((await endState(job)).runs).toEqual((await endState(sync)).runs);
  }finally{
   await owner.client.unsafe('drop trigger if exists section_fixture_refuse on person');
   await owner.client.unsafe('drop function if exists public.section_fixture_refuse()');
  }
 });

 it('saves each Family row as the synchronous import does, then refreshes child relief',async()=>{
  const sync=await fixture(),job=await fixture();
  const family=[
   {employee_code:'REG0',full_name:'Fictional child A',relationship:'child',date_of_birth:'2016-02-03'},
   {employee_code:'REG0',full_name:'Fictional child B',relationship:'child',date_of_birth:'2018-04-05'},
   {employee_code:'REG1',full_name:'Fictional spouse',relationship:'spouse',date_of_birth:'1990-01-01'},
  ];
  const expected=await commitSectionImport(sync.ctx,{section:'family',records:family,fileName:'Family · f.csv'});
  const progress=await runJob(job,'family',family,'Family · f.csv');
  expect(comparable(progress.result!)).toEqual(comparable(expected));
  const dependents=async(f:Fixture)=>(await owner.client<{full_name:string;relationship:string}[]>`select full_name,relationship from employee_dependent where tenant_id=${f.b.tenantId}::uuid order by full_name`);
  expect(await dependents(job)).toEqual(await dependents(sync));
  const relief=async(f:Fixture)=>(await owner.client<{n:string}[]>`select count(*)::text n from domain_event where tenant_id=${f.b.tenantId}::uuid and event_type like '%relief%'`)[0].n;
  expect(await relief(job)).toEqual(await relief(sync));
  expect((await endState(job)).runs).toEqual((await endState(sync)).runs);
 });

 it('refuses a file the fence refuses, writing nothing, with the synchronous file errors',async()=>{
  const sync=await fixture(),job=await fixture();
  const fenced=[{employee_code:'REG0',phone:'0130000000',bank_name:'Maybank'}];
  const expected=await commitSectionImport(sync.ctx,{section:'profile',records:fenced});
  expect(expected.fileErrors.length).toBeGreaterThan(0);
  const progress=await runJob(job,'profile',fenced);
  expect(progress.state).toBe('failed');
  expect(comparable(progress.result!)).toEqual(comparable(expected));
 });

 it('keeps the rows already saved when the creator stops it',async()=>{
  const job=await fixture();
  const {job:started}=await createSectionImportJob(job.ctx,{section:'profile',records:profileFile(),fileName:'p.csv',csv:'x',operationKey:randomUUID()});
  await ticks(started.id,j=>j.state==='running'&&j.steps_done>=1);
  await requestBulkJobCancel(job.ctx,started.id);
  await ticks(started.id);
  const progress=await getSectionImportJob(job.ctx,started.id);
  expect(progress.state).toBe('cancelled');
  expect(progress.result!.updated).toBeGreaterThanOrEqual(1);
  const [run]=await owner.client<{imported_rows:number}[]>`select imported_rows from employee_import_run where tenant_id=${job.b.tenantId}::uuid and file_name='p.csv'`;
  expect(run.imported_rows).toBe(progress.result!.updated);
 });
});
