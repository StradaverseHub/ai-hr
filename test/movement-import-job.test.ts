/** Movement import on the shared bulk-job kernel (draft 9910): real PostgreSQL, real RLS, real worker ticks.
 * The job's end state equals the synchronous confirmation's for the same file (movements, positions, managers,
 * company, statutory rows, Import History items and events, audit events), each employee is still saved all or
 * nothing, a lock refusal is retried instead of failing the employee, and authority is checked again in the worker. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createJobGrade,createPosition} from '../core/admin';
import {createMovementEvent,movementHistory} from '../core/movement';
import {previewMovementUpload,confirmMovementUpload,type MovementUploadResult} from '../core/movement-import-history';
import {getMovementCheckJob,getMovementImportJob,listMovementCheckJobs,listMovementImportJobs,startMovementCheckJob,startMovementImportJob,MovementImportJobError} from '../core/movement-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {getImportAttempt,previewImportRevert} from '../core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {revertImport} from '../core/import-history';
import {revertMovementByJob} from './movement-revert-job-helper';
import {createHash} from 'node:crypto';
import {movementRevertHandler} from '../core/movement-import-history';
import {verifyTenantChain} from '../core/audit-chain';
import {lockAccessConfigurationWriteTx} from '../core/access-configuration-lock';
import {bulkJobNoticeKeys} from '../lib/bulk-job';
import {MOVEMENT_IMPORT_ALREADY_RUNNING} from '../lib/movement-import-job';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';

vi.hoisted(()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const HEADER=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After'];
// The English catalogue, as the route's next-intl resolver supplies it (the job is started in English too).
const resolve=personnelImportLabelResolvers[0];
const file=(rows:string[][])=>Buffer.from(toCsv([HEADER,...rows]));
const tick=()=>runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});
type JobRow={id:string;state:string;steps_done:number;steps_total:number;transient_retries:number;metrics:Record<string,number>;notice_event_id:string|null;error:string|null};
const jobRow=async(id:string)=>(await owner.client<JobRow[]>`select id,state,steps_done,steps_total,transient_retries,metrics,notice_event_id,error from bulk_job where id=${id}::uuid`)[0];
async function ticks(id:string,stop:(job:JobRow)=>boolean,max=600){
 for(let i=0;i<max;i++){const job=await jobRow(id);if(stop(job))return job;if(!await tick())await new Promise(r=>setTimeout(r,60));}
 throw new Error('job did not reach the expected state');
}
const terminal=(job:JobRow)=>['completed','failed','cancelled'].includes(job.state);

type Fixture={b:Base;a:SessionContext;ids:Record<string,string>};
async function fixture():Promise<Fixture>{
 await resetDb();const b=await seedBase(),a=adminCtx(b);
 await owner.db.update(s.company).set({companyLabel:'ACME'}).where(eq(s.company.id,b.companyId));
 const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',companyLabel:'BETA',registrationNo:'202001000002'}).returning();
 await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:beta.id,name:'Beta Finance'});
 const junior=(await createJobGrade(a,{code:'JUNIOR',name:'Junior',rank:2})).id;await createJobGrade(a,{code:'SENIOR',name:'Senior',rank:1});
 await createPosition(a,{companyId:b.companyId,title:'Senior Executive'});
 await createPosition(a,{companyId:beta.id,title:'Beta Executive'});
 const ids:Record<string,string>={};
 for(const code of ['AC001','AC002','AC003','AC004','AC005','AC006']){
  const id=(await hireEmployee(a,{person:{fullName:'Fictional '+code,primaryEmail:`${code.toLowerCase()}@example.test`},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:day(-400),employeeCode:code})).employmentId;
  await owner.db.update(s.employment).set({gradeId:junior}).where(eq(s.employment.id,id));
  await setCompensation(a,{employmentId:id,basicSalary:3000,effectiveFrom:day(-400)});ids[code]=id;
 }
 // AC004 signs in: ending that employment is a change to who holds a login (an administrator-set site).
 const[{personId}]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,ids.AC004));
 await createAppUser(b.tenantId,personId,'employee');
 return{b,a,ids};
}
/** Two files covering every movement shape the brief names: grade, position and salary; department; manager; a
 * company change; an employee the check refused; one that fails at commit; and an exit of a person with a login.
 * The exit is its own file because an exit or company change alters the tenant's manager list, which every later
 * employee's reviewed fingerprint covers (the synchronous confirmation refuses them as stale; so does the job). */
const FILE_A=[
 ['ACME','AC001','',day(-1),'promotion','gradeId','JUNIOR','SENIOR'],
 ['ACME','AC001','',day(-1),'promotion','positionId','','Senior Executive'],
 ['ACME','AC001','',day(-1),'promotion','basicSalary','3000.00','3500'],
 ['ACME','AC002','',day(-1),'transfer','departmentId','','Operations'],
 ['ACME','AC002','',day(0),'reportingLineChange','managerEmploymentId','','AC001'],
 ['ACME','AC003','',day(-1),'transfer','departmentId','Operations','Operations'],
 ['ACME','AC006','',day(-1),'transfer','departmentId','','Operations'],
 ['ACME','AC005','',day(-1),'entityTransfer','companyId','','BETA'],
 ['ACME','AC005','',day(-1),'entityTransfer','departmentId','','Beta Finance'],
 ['ACME','AC005','',day(-1),'entityTransfer','positionId','','Beta Executive'],
];
const FILE_B=[
 ['ACME','AC004','',day(-2),'termination','endDate','',day(-2)],
 ['ACME','AC004','',day(-2),'termination','terminationReasonCode','','contract_expiry'],
];
const FILE_A_SCOPED=FILE_A.filter(row=>row[1]!=='AC005');
/** Preview a file; every named employee must be checked as expected. */
async function checked(f:Fixture,rows:string[][]=FILE_A,expected:{valid:string[];invalid:string[]}={valid:['AC001','AC002','AC005','AC006'],invalid:['AC003']},ctx:SessionContext=f.a){
 const preview=await previewMovementUpload(ctx,{name:'movements.csv',content:file(rows),resolve});
 const byCode=Object.fromEntries(preview.preview.employees.map(e=>[e.employeeCode,e]));
 for(const code of expected.valid)expect(byCode[code]?.fingerprint,code+' checked without errors: '+JSON.stringify(byCode[code]?.rows.flatMap(r=>r.errors))).toBeTruthy();
 for(const code of expected.invalid)expect(byCode[code]?.fingerprint).toBeNull();
 const keys=preview.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
 return{preview,keys};
}
/** The same check as a background job: the screen's language, a fresh operation key, every chunk run to the end. */
async function checkedByJob(f:Fixture,content:Buffer){
 const started=await startMovementCheckJob(f.a,{name:'movements.csv',content,locale:'en',operationKey:randomUUID()});
 expect(started.job.state).toBe('queued');
 const done=await ticks(started.job.id,terminal);
 expect(done.state).toBe('completed');
 const job=await getMovementCheckJob(f.a,started.job.id);
 return{preview:job.result!,keys:job.result!.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!),done};
}
const HEADER11=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After','Action','Movement Event ID','Reason'];
/** Shapes the lean single pass covers (an increment with a Before value and a new Direct Superior; organisation
 * warnings, which Import History records twice) and those it hands to the reference body: a future-dated movement
 * (scheduled), an Update correction and the actor's own employment. */
function fileC(updateOf:string){
 return Buffer.from(toCsv([HEADER11,
  ['ACME','AC001','',day(5),'promotion','gradeId','JUNIOR','SENIOR','','',''],
  ['ACME','AC002','',day(-25),'','','','','Update',updateOf,'Fictional wrong date'],
  ['ACME','AC003','',day(-1),'transfer','departmentId','','Operations','','',''],
  ['ACME','AC005','',day(-2),'promotion','gradeId','JUNIOR','SENIOR','','',''],
  ['ACME','AC005','',day(-2),'promotion','incrementAmount','','250','','',''],
  ['ACME','AC005','',day(-1),'reportingLineChange','managerEmploymentId','','AC001','','',''],
  ['ACME','AC006','',day(-1),'transfer','departmentId','','Operations','','',''],
  ['ACME','AC006','',day(-1),'transfer','parentCompany','','Fictional Parent Bhd','','',''],
 ]));
}
/** Fixture additions for file C: AC002's transfer to correct, and the administrator signing in as AC003's person. */
async function prepareC(f:Fixture){
 await createMovementEvent(f.a,{employmentId:f.ids.AC002,kind:'transfer',effectiveDate:day(-30),departmentId:f.b.deptB});
 const moved=(await movementHistory(f.a,f.ids.AC002)).find(row=>row.kind==='transfer'&&!row.reversed);
 if(!moved)throw new Error('expected the transfer to correct');
 const[{personId}]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,f.ids.AC003));
 await owner.db.update(s.appUser).set({personId}).where(eq(s.appUser.id,f.b.adminUserId));
 // The session names the person its login now belongs to, as a fresh sign-in would.
 f.a={...f.a,personId};
 return{updateOf:moved.id};
}
/** After review, AC006 gets a new Direct Superior elsewhere: its reviewed state is stale, so its commit is refused. */
const makeStale=(f:Fixture)=>createMovementEvent(f.a,{employmentId:f.ids.AC006,kind:'reportingLineChange',effectiveDate:day(-3),managerEmploymentId:f.ids.AC003});

// ---- End-state snapshot, canonical across two runs: entity ids become their natural names, other ids become
// tokens in first-appearance order, timestamps become 'T' (null stays null), audit-chain bookkeeping is dropped.
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const EXCLUDED_TABLES=new Set(['bulk_job','bulk_job_step','bulk_job_worker','import_attempt']);
const CHAIN_COLUMNS=new Set(['sequence','chain_seq','hash','prev_hash','chain_hash','previous_hash']);
async function snapshot(tenantId:string){
 const names=new Map<string,string>([[tenantId,'TENANT']]);
 const name=async(prefix:string,q:Promise<{id:string;k:string|null}[]>)=>{for(const r of await q)names.set(r.id,`${prefix}:${r.k}`);};
 await name('E',owner.client`select id,employee_code k from employment where tenant_id=${tenantId}::uuid`);
 await name('P',owner.client`select id,primary_email k from person where tenant_id=${tenantId}::uuid`);
 await name('C',owner.client`select id,legal_name k from company where tenant_id=${tenantId}::uuid`);
 await name('D',owner.client`select id,name k from department where tenant_id=${tenantId}::uuid`);
 await name('POS',owner.client`select id,title k from position where tenant_id=${tenantId}::uuid`);
 await name('G',owner.client`select id,code k from job_grade where tenant_id=${tenantId}::uuid`);
 await name('U',owner.client`select u.id,coalesce(p.primary_email,'admin') k from app_user u left join person p on p.id=u.person_id where u.tenant_id=${tenantId}::uuid`);
 const tables=(await owner.client<{table_name:string}[]>`select distinct c.table_name from information_schema.columns c
   join information_schema.columns t on t.table_schema='public' and t.table_name=c.table_name and t.column_name='tenant_id'
   join information_schema.tables k on k.table_schema='public' and k.table_name=c.table_name and k.table_type='BASE TABLE'
  where c.table_schema='public' and c.column_name in ('employment_id','person_id','subordinate_employment_id','attempt_id','aggregate_id')
  order by 1`).map(r=>r.table_name).filter(t=>!EXCLUDED_TABLES.has(t)&&!t.startsWith('notification'));
 const isTimestamp=(v:string)=>TIMESTAMP.test(v)&&v.length>10;
 const blank=(v:unknown):unknown=>typeof v==='string'?(isTimestamp(v)?'T':v.replace(UUID,m=>names.get(m.toLowerCase())??'<id>')):Array.isArray(v)?v.map(blank):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,blank(x)])):v;
 const raw:Record<string,Record<string,unknown>[]>={};
 for(const table of [...new Set([...tables,'employment','person'])]){
  // to_jsonb keeps dates as dates and makes every timestamp an ISO string (normalized to 'T' below).
  const order=table==='domain_event'?'order by t.sequence':table==='import_attempt_event'?'order by t.created_at,t.kind':'';
  const filter=table==='domain_event'?"and t.event_type not like 'bulk-job.%'":'';
  const rows=(await owner.client.unsafe<{j:Record<string,unknown>}[]>(`select to_jsonb(t) as j from ${table} t where t.tenant_id=$1 ${filter} ${order}`,[tenantId])).map(r=>table==='domain_event'?Object.fromEntries(Object.entries(r.j).filter(([k])=>!CHAIN_COLUMNS.has(k))):r.j);
  const keyed=rows.map(row=>({row,key:JSON.stringify(blank(row))}));
  if(!order)keyed.sort((x,y)=>x.key<y.key?-1:x.key>y.key?1:0);
  raw[table]=keyed.map(k=>k.row);
 }
 // Second pass: unnamed ids become tokens in traversal order (identical in two runs that wrote the same rows).
 const tokens=new Map<string,string>();
 const canon=(v:unknown):unknown=>typeof v==='string'?(isTimestamp(v)?'T':v.replace(UUID,m=>{const id=m.toLowerCase();if(names.has(id))return names.get(id)!;if(!tokens.has(id))tokens.set(id,`#${tokens.size}`);return tokens.get(id)!;})):Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,canon(x)])):v;
 const result:Record<string,unknown[]>={};
 for(const [table,rows] of Object.entries(raw))result[table]=rows.map(canon);
 return{tables:result,canon};
}
/** Audit events grouped per employee, each employee's own order kept: a revert compensates employee by employee in
 * employment-id order (revertOrder), and the ids differ between two fixture runs. */
const perEmployeeEvents=(tables:Record<string,unknown[]>)=>{
 const events=(tables.domain_event as {subject_employment_id:string|null}[]).map((row,index)=>({row,index}));
 events.sort((x,y)=>String(x.row.subject_employment_id??'').localeCompare(String(y.row.subject_employment_id??''))||x.index-y.index);
 const grouped:Record<string,unknown[]>={...tables,domain_event:events.map(e=>e.row)};
 // Anonymous ids were numbered in the original traversal; number them again in this one.
 const tokens=new Map<string,string>();
 const renumber=(v:unknown):unknown=>typeof v==='string'?v.replace(/#\d+/g,m=>{if(!tokens.has(m))tokens.set(m,`#${tokens.size}`);return tokens.get(m)!;}):Array.isArray(v)?v.map(renumber):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,renumber(x)])):v;
 return Object.fromEntries(Object.keys(grouped).sort().map(k=>[k,renumber(grouped[k])]));
};
/** The revert's own events follow the employees in employment-id order, as the synchronous revert's do. */
async function revertEventsInEmploymentOrder(tenantId:string,attemptIds:string[]){
 for(const attemptId of attemptIds){
  const rows=await owner.client<{subject:string}[]>`select subject_employment_id::text subject from domain_event where tenant_id=${tenantId}::uuid and event_type in ('employment.movement.reversed') and payload->>'reason'='Fictional wrong batch' and sequence>(select min(sequence) from domain_event where tenant_id=${tenantId}::uuid and aggregate_id=${attemptId}::uuid and event_type='import-attempt.confirmed') and subject_employment_id in (select employment_id from import_attempt_item where attempt_id=${attemptId}::uuid) order by sequence`;
  const subjects=rows.map(r=>r.subject);const firsts=subjects.filter((x,i)=>subjects.indexOf(x)===i);
  expect(firsts).toEqual([...firsts].sort());
 }
}
/** The confirmation result without its opaque digests (they hash row ids, which differ between runs). */
const comparable=(result:MovementUploadResult,canon:(v:unknown)=>unknown)=>canon({...result,employees:result.employees.map(e=>({...e,fingerprint:e.fingerprint?'<digest>':null}))});

let f:Fixture;
beforeAll(migrateTestDb);
beforeEach(async()=>{f=await fixture();});
afterAll(closeAll);

describe('movement import background job (bulk-job kernel)',()=>{
 it('ends in the same state as the synchronous confirmation: movements, positions, managers, company, statutory, Import History and audit',async()=>{
  const failedRows=(r:MovementUploadResult)=>r.employees.flatMap(e=>e.rows.filter(x=>x.status==='failed').map(x=>e.employeeCode+':'+x.errors.join(',')));
  // Run 1: the synchronous reference path, file A then (reviewed after A) file B.
  const a1=await checked(f);await makeStale(f);
  const syncA=await confirmMovementUpload(f.a,{attemptId:a1.preview.attemptId,previewHash:a1.preview.previewHash,employees:a1.keys,acknowledgeExcluded:true,resolve});
  expect(failedRows(syncA)).toEqual(['AC006:preview_stale_revalidate']);
  expect(syncA).toMatchObject({imported:4,failed:1,alreadyCommitted:false});
  const b1=await checked(f,FILE_B,{valid:['AC004'],invalid:[]});
  const syncB=await confirmMovementUpload(f.a,{attemptId:b1.preview.attemptId,previewHash:b1.preview.previewHash,employees:b1.keys,acknowledgeExcluded:true,resolve});
  expect(syncB).toMatchObject({imported:1,failed:0,alreadyCommitted:false});
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const before=await snapshot(f.b.tenantId);const syncResults=[comparable(syncA,before.canon),comparable(syncB,before.canon)];
  // Run 2: the same fixture and files, each confirmed as a background job.
  f=await fixture();
  const job=async(c:Awaited<ReturnType<typeof checked>>,employees:number)=>{
   const started=await startMovementImportJob(f.a,{attemptId:c.preview.attemptId,previewHash:c.preview.previewHash,employees:c.keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});
   if(!('job' in started))throw new Error('expected a job');
   expect(started.job).toMatchObject({state:'queued',attemptId:c.preview.attemptId});
   // Nothing is written by the request itself.
   expect((await getImportAttempt(f.a,c.preview.attemptId))!.items).toHaveLength(0);
   const done=await ticks(started.job.id,terminal);
   expect(done).toMatchObject({state:'completed',steps_total:employees,steps_done:employees});
   // A chunk takes another employee only while it has done less than about 100 ms of work (at most four).
   expect(Number(done.metrics.chunks)).toBeGreaterThanOrEqual(Math.ceil(employees/4));expect(Number(done.metrics.chunkHoldMs)).toBeGreaterThan(0);
   expect(done.notice_event_id).toBeTruthy();
   const[notice]=await owner.client<{event_type:string;payload:{kind:string;outcome:string}}[]>`select event_type,payload from domain_event where id=${done.notice_event_id}::uuid`;
   expect(notice).toMatchObject({event_type:'bulk-job.finished',payload:{kind:'movement_import',outcome:'completed'}});
   const[residue]=await owner.client<{steps:number;input:unknown}[]>`select (select count(*)::int from bulk_job_step where job_id=${started.job.id}::uuid) steps,(select input from bulk_job where id=${started.job.id}::uuid) as input`;
   expect(residue).toEqual({steps:0,input:null});
   return getMovementImportJob(f.a,started.job.id);
  };
  const a2=await checked(f);await makeStale(f);
  const jobA=await job(a2,4);
  expect(jobA).toMatchObject({state:'completed',stepsDone:4,stepsTotal:4,imported:4,failed:1});
  const b2=await checked(f,FILE_B,{valid:['AC004'],invalid:[]});
  const jobB=await job(b2,1);
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const after=await snapshot(f.b.tenantId);
  expect(Object.keys(after.tables).length).toBeGreaterThan(20);
  expect(after.tables).toEqual(before.tables);
  expect([comparable(jobA.result!,after.canon),comparable(jobB.result!,after.canon)]).toEqual(syncResults);
  // Row-level outcome as before: AC006 failed at commit (stale review), AC003 was refused by the check.
  const detail=(await getImportAttempt(f.a,a2.preview.attemptId))!;
  expect(detail.items.filter(i=>i.status==='failed').map(i=>i.label).sort()).toEqual(['AC003 · Fictional AC003','AC006 · Fictional AC006']);
  expect(detail.events.find(e=>e.kind==='confirmed')?.detail).toEqual({succeeded:4,failed:2});
 },300_000);

 it('retries a lock refusal instead of failing the employee, and saves each employee once',async()=>{
  const{preview,keys}=await checked(f);
  const started=await startMovementImportJob(f.a,{attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en'});
  if(!('job' in started))throw new Error('expected a job');
  await ticks(started.job.id,j=>j.state==='running');
  // Another Access writer holds the tenant lock (exclusive, as every Access writer did when this was written; the
  // lock is reader/writer now) longer than the employee transaction's 1 s lock wait.
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let locked!:()=>void;const isLocked=new Promise<void>(r=>{locked=r;});
  const holder=withTenant(f.a,async tx=>{await lockAccessConfigurationWriteTx(tx,f.b.tenantId);locked();await held;});
  await isLocked;
  expect(await tick()).toBe(true);
  const waited=await jobRow(started.job.id);
  expect(waited.state).toBe('running');expect(waited.transient_retries).toBeGreaterThan(0);expect(waited.steps_done).toBe(0);
  release();await holder;
  const done=await ticks(started.job.id,terminal);
  expect(done.state).toBe('completed');
  const result=(await getMovementImportJob(f.a,started.job.id)).result!;
  expect(result).toMatchObject({imported:5,failed:0});
  const[counted]=await owner.client<{n:number}[]>`select count(*)::int n from domain_event where tenant_id=${f.b.tenantId}::uuid and event_type='movement-import.employee.applied'`;
  expect(counted.n).toBe(4);
 },180_000);

 it('repeats the confirmation checks: a confirmed attempt answers with its counts, a repeated request rejoins its job, one job per person',async()=>{
  const{preview,keys}=await checked(f);
  const input={attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()};
  const first=await startMovementImportJob(f.a,input);if(!('job' in first))throw new Error('expected a job');
  const again=await startMovementImportJob(f.a,input);
  expect(again).toMatchObject({existing:true,job:{id:first.job.id}});
  await expect(startMovementImportJob(f.a,{...input,operationKey:randomUUID()})).rejects.toMatchObject({message:MOVEMENT_IMPORT_ALREADY_RUNNING,status:409});
  expect((await listMovementImportJobs(f.a)).map(j=>j.id)).toEqual([first.job.id]);
  await ticks(first.job.id,terminal);
  const answered=await startMovementImportJob(f.a,{...input,operationKey:randomUUID()});
  expect(answered).toEqual({already:expect.objectContaining({alreadyCommitted:true,imported:5,failed:1})});
  // A stale review is refused at the request, and the refusal is recorded on the attempt as before.
  const second=await previewMovementUpload(f.a,{name:'again.csv',content:file(FILE_B),resolve});
  await expect(startMovementImportJob(f.a,{...input,attemptId:second.attemptId,previewHash:'0'.repeat(64),employees:[second.preview.employees[0].key!],operationKey:randomUUID()})).rejects.toThrow(/upload it again before saving/i);
  expect((await getImportAttempt(f.a,second.attemptId))!.events.map(e=>e.kind)).toContain('failed');
 },180_000);

 it('checks the initiator again in the worker: lost company access stops the job before any employee is saved',async()=>{
  const[p]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'Scoped Fictional Admin',primaryEmail:'scoped-movement@example.test'}).returning();
  const userId=await createAppUser(f.b.tenantId,p.id,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId:f.b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const scoped:SessionContext={...f.a,userId,personId:p.id,grants:[{role:'hr_admin',companyId:f.b.companyId}]};
  const{preview,keys}=await checked(f,FILE_A_SCOPED,{valid:['AC001','AC002','AC006'],invalid:['AC003']},scoped);
  const started=await startMovementImportJob(scoped,{attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en'});
  if(!('job' in started))throw new Error('expected a job');
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,userId));
  const done=await ticks(started.job.id,terminal);
  expect(done.state).toBe('failed');
  const[applied]=await owner.client<{n:number}[]>`select count(*)::int n from domain_event where tenant_id=${f.b.tenantId}::uuid and event_type='movement-import.employee.applied'`;
  expect(applied.n).toBe(0);
  const[events]=await owner.client<{kinds:string[]}[]>`select array_agg(kind order by created_at) kinds from import_attempt_event where attempt_id=${preview.attemptId}::uuid`;
  // As in the synchronous confirmation, an initiator who no longer sees the attempt cannot record on it either.
  expect(events.kinds).toEqual(['previewed']);
  expect(done.error).toBe('Your access to this job changed, so it was stopped.');
 },180_000);

 it('checks a file as a background job: the same preview, fingerprints and sealed plan as the synchronous check, nothing written',async()=>{
  const sync=await previewMovementUpload(f.a,{name:'movements.csv',content:file(FILE_A),resolve});
  const hrRows=async()=>(await owner.client<{n:number}[]>`select (select count(*) from assignment where tenant_id=${f.b.tenantId}::uuid)+(select count(*) from compensation where tenant_id=${f.b.tenantId}::uuid)+(select count(*) from reporting_line where tenant_id=${f.b.tenantId}::uuid)+(select count(*) from domain_event where tenant_id=${f.b.tenantId}::uuid and event_type not like 'import-attempt.%' and event_type not like 'bulk-job.%')+(select count(*) from leave_ledger where tenant_id=${f.b.tenantId}::uuid) as n`)[0].n;
  const before=await hrRows();
  const started=await startMovementCheckJob(f.a,{name:'movements.csv',content:file(FILE_A),locale:'en',operationKey:randomUUID()});
  // The request stores the file and nothing else: no attempt yet.
  expect((await owner.client`select 1 from import_attempt where tenant_id=${f.b.tenantId}::uuid`).length).toBe(1);
  const done=await ticks(started.job.id,terminal);
  expect(done).toMatchObject({state:'completed',steps_total:5,steps_done:5});
  expect(Number(done.metrics.chunks)).toBeGreaterThanOrEqual(1);
  const job=await getMovementCheckJob(f.a,started.job.id);
  expect(job.state).toBe('completed');
  expect(job.result!.preview).toEqual(sync.preview);
  expect(job.result!.preview.employees.filter(e=>e.fingerprint).map(e=>e.employeeCode).sort()).toEqual(['AC001','AC002','AC005','AC006']);
  expect(job.result!.previewHash).toBe(sync.previewHash);
  expect(job.result!.attemptId).not.toBe(sync.attemptId);
  const plans=await owner.client<{id:string;plan:unknown;kind:string;source_name:string;company_ids:string[]}[]>`select id,plan,kind,source_name,company_ids from import_attempt where id in (${sync.attemptId}::uuid,${job.result!.attemptId}::uuid)`;
  const byId=Object.fromEntries(plans.map(p=>[p.id,{plan:p.plan,kind:p.kind,name:p.source_name,companies:p.company_ids}]));
  expect(byId[job.result!.attemptId]).toEqual(byId[sync.attemptId]);
  expect(await hrRows()).toBe(before);
  const[residue]=await owner.client<{steps:number;input:unknown;content:unknown}[]>`select (select count(*)::int from bulk_job_step where job_id=${started.job.id}::uuid) steps,input,source_content content from bulk_job where id=${started.job.id}::uuid`;
  expect(residue).toEqual({steps:0,input:null,content:null});
  // The attempt holds the actual uploaded bytes, as the synchronous check recorded them.
  const uploaded=file(FILE_A);
  const[stored]=await owner.client<{content:Buffer;hash:string;name:string;mime:string}[]>`select source_content content,source_hash hash,source_name name,mime_type mime from import_attempt where id=${job.result!.attemptId}::uuid`;
  expect(Buffer.from(stored.content).equals(uploaded)).toBe(true);
  expect(stored.hash).toBe(createHash('sha256').update(uploaded).digest('hex'));
  expect(stored.name).toBe('movements.csv');expect(stored.mime).toBe('text/csv');
  // While it is unconfirmed, the screen may show it again on return.
  expect((await listMovementCheckJobs(f.a))[0]).toMatchObject({id:started.job.id,state:'completed',reviewOpen:true});
  // The reference and preview hash are what the confirmation verifies: a different hash is refused and recorded.
  await expect(startMovementImportJob(f.a,{attemptId:job.result!.attemptId,previewHash:'f'.repeat(64),employees:['x'],acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()})).rejects.toThrow(/upload it again before saving/i);
  // The background attempt confirms exactly like the synchronous one.
  const keys=job.result!.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
  const confirmed=await startMovementImportJob(f.a,{attemptId:job.result!.attemptId,previewHash:job.result!.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});
  if(!('job' in confirmed))throw new Error('expected a job');
  await ticks(confirmed.job.id,terminal);
  expect((await getMovementImportJob(f.a,confirmed.job.id)).result).toMatchObject({imported:5,failed:0});
  expect((await listMovementCheckJobs(f.a))[0]).toMatchObject({id:started.job.id,reviewOpen:false});
 },300_000);

 it('reverts as a job with one verified set-based release, ending exactly like the synchronous revert',async()=>{
  // Run 1: the synchronous revert of both files, confirmed through the job as the screen does.
  const confirmBoth=async()=>{
   const a=await checked(f);
   const ja=await startMovementImportJob(f.a,{attemptId:a.preview.attemptId,previewHash:a.preview.previewHash,employees:a.keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});if(!('job' in ja))throw new Error('expected a job');await ticks(ja.job.id,terminal);
   const b=await checked(f,FILE_B,{valid:['AC004'],invalid:[]});
   const jb=await startMovementImportJob(f.a,{attemptId:b.preview.attemptId,previewHash:b.preview.previewHash,employees:b.keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});if(!('job' in jb))throw new Error('expected a job');await ticks(jb.job.id,terminal);
   return[a.preview.attemptId,b.preview.attemptId];
  };
  const attempts1=await confirmBoth();
  for(const attemptId of attempts1){const review=await previewImportRevertForAttempt(f.a,attemptId);expect(review.eligible).toBe(true);
   await revertImport(f.a,attemptId,movementRevertHandler,{previewHash:review.previewHash,reason:'Fictional wrong batch'});}
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const before=await snapshot(f.b.tenantId);
  // Run 2: the same fixture, files and reasons, reverted as jobs.
  f=await fixture();
  const attempts2=await confirmBoth();
  for(const attemptId of attempts2){const review=await previewImportRevertForAttempt(f.a,attemptId);
   const done=await revertMovementByJob(f.a,attemptId,{previewHash:review.previewHash,reason:'Fictional wrong batch'});
   const[job]=await owner.client<{counters:Record<string,number>;metrics:Record<string,number>;plan:{released?:{path:string};fallback?:string}}[]>`select counters,metrics,plan from bulk_job where id=${(done as {jobId:string}).jobId}::uuid`;
   // Planned per employee, then released set-based (no fallback).
   expect(job.plan.released?.path,JSON.stringify(job.plan)).toBe('release');expect(job.counters).toMatchObject({released:1});expect(job.counters.reference).toBeUndefined();
   expect(Number(job.metrics.releaseTxMs)).toBeGreaterThan(0);
  }
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const after=await snapshot(f.b.tenantId);
  expect(perEmployeeEvents(after.tables)).toEqual(perEmployeeEvents(before.tables));
  await revertEventsInEmploymentOrder(f.b.tenantId,attempts2);
 },300_000);

 it('falls back to the synchronous revert for the whole import when a planned record changed before the release',async()=>{
  const confirmA=async()=>{
   const a=await checked(f);
   const ja=await startMovementImportJob(f.a,{attemptId:a.preview.attemptId,previewHash:a.preview.previewHash,employees:a.keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});if(!('job' in ja))throw new Error('expected a job');await ticks(ja.job.id,terminal);
   return a.preview.attemptId;
  };
  // An unrelated edit of a planned employee's own record (not a field the import changed: no blocker).
  const edit=(f:Fixture)=>owner.client`update employment set org_division='Fictional division' where id=${f.ids.AC001}::uuid`;
  // Run 1: the edit, then the synchronous revert.
  const attempt1=await confirmA();const review1=await previewImportRevertForAttempt(f.a,attempt1);
  await edit(f);
  await revertImport(f.a,attempt1,movementRevertHandler,{previewHash:review1.previewHash,reason:'Fictional wrong batch'});
  const before=await snapshot(f.b.tenantId);
  // Run 2: the job plans every employee, the edit lands before the release, so the whole revert is the synchronous one.
  f=await fixture();
  const attempt2=await confirmA();const review2=await previewImportRevertForAttempt(f.a,attempt2);
  const out=await revertImportForAttempt(f.a,attempt2,{previewHash:review2.previewHash,reason:'Fictional wrong batch'});
  if(!('job' in out))throw new Error('expected a job');
  await ticks(out.job.id,j=>j.state==='finalizing'||terminal(j));
  await edit(f);
  const done=await ticks(out.job.id,terminal);
  expect(done.state).toBe('completed');
  const[job]=await owner.client<{counters:Record<string,number>;plan:{released?:{path:string};fallback?:string}}[]>`select counters,plan from bulk_job where id=${out.job.id}::uuid`;
  expect(job.plan.released?.path).toBe('reference');expect(job.plan.fallback).toBe('records:employment');expect(job.counters).toMatchObject({reference:1});
  const after=await snapshot(f.b.tenantId);
  expect(perEmployeeEvents(after.tables)).toEqual(perEmployeeEvents(before.tables));
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
 },300_000);

 it('the lean commit and its hand-backs (future-dated, Update, the actor\'s own employment) end like the synchronous confirmation',async()=>{
  const failedRows=(r:MovementUploadResult)=>r.employees.flatMap(e=>e.rows.filter(x=>x.status==='failed').map(x=>e.employeeCode+':'+x.errors.join(',')));
  const first=await prepareC(f);
  const sync1=await previewMovementUpload(f.a,{name:'c.csv',content:fileC(first.updateOf),resolve});
  const keys1=sync1.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
  expect(sync1.preview.employees.filter(e=>e.fingerprint).map(e=>e.employeeCode).sort(),JSON.stringify(sync1.preview.employees.map(e=>[e.employeeCode,e.rows.flatMap(r=>r.errors)]))).toEqual(['AC001','AC002','AC003','AC005','AC006']);
  const syncC=await confirmMovementUpload(f.a,{attemptId:sync1.attemptId,previewHash:sync1.previewHash,employees:keys1,acknowledgeExcluded:true,resolve});
  expect(failedRows(syncC)).toEqual([]);
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const before=await snapshot(f.b.tenantId);const syncResult=comparable(syncC,before.canon);
  f=await fixture();
  const second=await prepareC(f);
  const {preview:check,keys:keys2}=await checkedByJob(f,fileC(second.updateOf));
  const job=await startMovementImportJob(f.a,{attemptId:check.attemptId,previewHash:check.previewHash,employees:keys2,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});
  if(!('job' in job))throw new Error('expected a job');
  await ticks(job.job.id,terminal);
  const[counted]=await owner.client<{counters:Record<string,number>}[]>`select counters from bulk_job where id=${job.job.id}::uuid`;
  // AC005 and AC006 in one pass; AC001 (scheduled), AC002 (Update) and AC003 (the actor's own) through the reference body.
  expect(counted.counters).toMatchObject({leanEmployees:2,referenceEmployees:3,imported:6});
  const jobC=await getMovementImportJob(f.a,job.job.id);
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const after=await snapshot(f.b.tenantId);
  // The two files differ only in the Movement Event ID they correct (a fresh id per run), so the recorded file hash does.
  const sourceless=(tables:Record<string,unknown[]>)=>JSON.parse(JSON.stringify(tables).replace(/"sourceHash":"[0-9a-f]{64}"/g,'"sourceHash":"<file>"'));
  expect(JSON.stringify(after.tables).match(/"sourceHash":"[0-9a-f]{64}"/g)?.length).toBe(JSON.stringify(before.tables).match(/"sourceHash":"[0-9a-f]{64}"/g)?.length);
  expect(sourceless(after.tables)).toEqual(sourceless(before.tables));
  expect(comparable(jobC.result!,after.canon)).toEqual(syncResult);
  // The organisation warning appears twice on the item, as the rehearse-then-apply commit recorded it.
  const items=await owner.client<{after:{organisationWarnings?:string[]}}[]>`select after from import_attempt_item where attempt_id=${check.attemptId}::uuid and employment_id=${f.ids.AC006}::uuid`;
  expect(items.map(i=>i.after.organisationWarnings?.length)).toEqual([2]);
 },300_000);

 it('reviews a create-only movement revert on a read-only snapshot without the writer locks, with the locked review\'s result',async()=>{
  const{preview,keys}=await checked(f);
  const started=await startMovementImportJob(f.a,{attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en'});
  if(!('job' in started))throw new Error('expected a job');
  await ticks(started.job.id,terminal);
  const locked=await previewImportRevert(f.a,preview.attemptId,movementRevertHandler);
  expect(locked.eligible).toBe(true);expect(locked.items.length).toBeGreaterThan(4);
  // Another Access writer holds the tenant lock for longer than the review takes.
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let locked2!:()=>void;const isLocked=new Promise<void>(r=>{locked2=r;});
  const holder=withTenant(f.a,async tx=>{await lockAccessConfigurationWriteTx(tx,f.b.tenantId);await tx.execute(sql`select app.access_configuration_write_lock()`);locked2();await held;});
  await isLocked;
  const review=await Promise.race([previewImportRevertForAttempt(f.a,preview.attemptId),new Promise<'waited'>(r=>setTimeout(()=>r('waited'),8000))]);
  release();await holder;
  expect(review).not.toBe('waited');
  expect(review).toEqual(locked);
  // The reviewed hash is the one the locked revert re-checks.
  await expect(revertMovementByJob(f.a,preview.attemptId,{previewHash:(review as typeof locked).previewHash,reason:'Fictional revert after a lock-free review'})).resolves.toMatchObject({restored:locked.items.length});
 },180_000);

 it('names its completion notice in all six catalogues',()=>{
  for(const outcome of ['completed','failed','cancelled'] as const){
   const check=bulkJobNoticeKeys('movement_check',outcome)!;expect(check.linkPath).toBe('/admin/personnel/import/history?kind=movement');
   for(const catalogue of [en,ms,zh,ta,th,vi_]){
    const group=(catalogue as unknown as {bulkJobs:{notification:Record<string,Record<string,{title:string;body:string}>>}}).bulkJobs.notification.movementCheck[outcome];
    expect(group.title.length).toBeGreaterThan(3);expect(group.body.length).toBeGreaterThan(3);
    const job=(catalogue as unknown as {people:{import:{movementCheckJob:Record<string,string>}}}).people.import.movementCheckJob;
    expect(Object.keys(job).sort()).toEqual(Object.keys(en.people.import.movementCheckJob).sort());
   }
   const keys=bulkJobNoticeKeys('movement_import',outcome)!;expect(keys.linkPath).toBe('/admin/personnel/import/history?kind=movement');
   for(const catalogue of [en,ms,zh,ta,th,vi_]){
    const group=(catalogue as unknown as {bulkJobs:{notification:Record<string,Record<string,{title:string;body:string}>>}}).bulkJobs.notification.movementImport[outcome];
    expect(group.title.length).toBeGreaterThan(3);expect(group.body.length).toBeGreaterThan(3);
    const job=(catalogue as unknown as {people:{import:{movementJob:Record<string,string>}}}).people.import.movementJob;
    expect(Object.keys(job).sort()).toEqual(Object.keys(en.people.import.movementJob).sort());
   }
  }
  expect(new MovementImportJobError('x').status).toBe(400);
 });
});
