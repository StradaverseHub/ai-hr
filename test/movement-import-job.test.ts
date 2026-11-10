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
import {createMovementEvent} from '../core/movement';
import {previewMovementUpload,confirmMovementUpload,type MovementUploadResult} from '../core/movement-import-history';
import {getMovementImportJob,listMovementImportJobs,startMovementImportJob,MovementImportJobError} from '../core/movement-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {getImportAttempt} from '../core/import-history';
import {verifyTenantChain} from '../core/audit-chain';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
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
/** One file covering every movement shape the brief names: grade, position and salary; department; manager;
 * an exit of a person with a login; a company change; an employee the check refused; one that fails at commit. */
const FILE=[
 ['ACME','AC001','',day(-1),'promotion','gradeId','JUNIOR','SENIOR'],
 ['ACME','AC001','',day(-1),'promotion','positionId','','Senior Executive'],
 ['ACME','AC001','',day(-1),'promotion','basicSalary','3000.00','3500'],
 ['ACME','AC002','',day(-1),'transfer','departmentId','','Operations'],
 ['ACME','AC002','',day(0),'reportingLineChange','managerEmploymentId','','AC001'],
 ['ACME','AC003','',day(-1),'transfer','departmentId','Operations','Operations'],
 ['ACME','AC004','',day(-2),'termination','endDate','',day(-2)],
 ['ACME','AC004','',day(-2),'termination','terminationReasonCode','','contract_expiry'],
 ['ACME','AC005','',day(-1),'entityTransfer','companyId','','BETA'],
 ['ACME','AC005','',day(-1),'entityTransfer','departmentId','','Beta Finance'],
 ['ACME','AC006','',day(-1),'transfer','departmentId','','Operations'],
];
/** Preview, then make AC006's reviewed state stale so its commit is refused (a row-level failure). */
async function checked(f:Fixture,ctx:SessionContext=f.a){
 const preview=await previewMovementUpload(ctx,{name:'movements.csv',content:file(FILE),resolve});
 const byCode=Object.fromEntries(preview.preview.employees.map(e=>[e.employeeCode,e]));
 for(const code of ['AC001','AC002','AC004','AC005','AC006'])expect(byCode[code]?.fingerprint,code+' checked without errors').toBeTruthy();
 expect(byCode.AC003.fingerprint).toBeNull();
 await createMovementEvent(f.a,{employmentId:f.ids.AC006,kind:'transfer',effectiveDate:day(-3),departmentId:f.b.deptB});
 const keys=preview.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
 return{preview,keys};
}

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
/** The confirmation result without its opaque digests (they hash row ids, which differ between runs). */
const comparable=(result:MovementUploadResult,canon:(v:unknown)=>unknown)=>canon({...result,employees:result.employees.map(e=>({...e,fingerprint:e.fingerprint?'<digest>':null}))});

let f:Fixture;
beforeAll(migrateTestDb);
beforeEach(async()=>{f=await fixture();});
afterAll(closeAll);

describe('movement import background job (bulk-job kernel)',()=>{
 it('ends in the same state as the synchronous confirmation: movements, positions, managers, company, statutory, Import History and audit',async()=>{
  // Run 1: the synchronous reference path.
  const one=await checked(f);
  const sync=await confirmMovementUpload(f.a,{attemptId:one.preview.attemptId,previewHash:one.preview.previewHash,employees:one.keys,acknowledgeExcluded:true,resolve});
  expect(sync).toMatchObject({imported:6,failed:1,alreadyCommitted:false});
  const syncChain=await verifyTenantChain(f.a);expect(syncChain).toMatchObject({valid:true});
  const before=await snapshot(f.b.tenantId);const syncResult=comparable(sync,before.canon);
  // Run 2: the same fixture and file, confirmed as a background job.
  f=await fixture();
  const two=await checked(f);
  const started=await startMovementImportJob(f.a,{attemptId:two.preview.attemptId,previewHash:two.preview.previewHash,employees:two.keys,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});
  if(!('job' in started))throw new Error('expected a job');
  expect(started.job).toMatchObject({state:'queued',attemptId:two.preview.attemptId});
  // Nothing is written by the request itself.
  expect((await getImportAttempt(f.a,two.preview.attemptId))!.items).toHaveLength(0);
  const done=await ticks(started.job.id,terminal);
  expect(done.state).toBe('completed');expect(done.steps_total).toBe(5);expect(done.steps_done).toBe(5);
  // One employee per chunk: the Access lock is held for one employee's commit at a time.
  expect(Number(done.metrics.chunks)).toBeGreaterThanOrEqual(5);expect(Number(done.metrics.chunkHoldMs)).toBeGreaterThan(0);
  const progress=await getMovementImportJob(f.a,started.job.id);
  expect(progress).toMatchObject({state:'completed',stepsDone:5,stepsTotal:5,imported:6,failed:1});
  expect(await verifyTenantChain(f.a)).toMatchObject({valid:true});
  const after=await snapshot(f.b.tenantId);
  expect(after.tables).toEqual(before.tables);
  expect(comparable(progress.result!,after.canon)).toEqual(syncResult);
  // Row-level outcome as before: AC006 failed with the stale-preview refusal, AC003 was refused by the check.
  const detail=(await getImportAttempt(f.a,two.preview.attemptId))!;
  expect(detail.items.filter(i=>i.status==='failed').map(i=>i.label).sort()).toEqual(['AC003 · Fictional AC003','AC006 · Fictional AC006']);
  expect(detail.events.find(e=>e.kind==='confirmed')?.detail).toEqual({succeeded:6,failed:2});
  // The creator is told once, through the kernel notice.
  expect(done.notice_event_id).toBeTruthy();
  const[notice]=await owner.client<{event_type:string;payload:{kind:string;outcome:string}}[]>`select event_type,payload from domain_event where id=${done.notice_event_id}::uuid`;
  expect(notice).toMatchObject({event_type:'bulk-job.finished',payload:{kind:'movement_import',outcome:'completed'}});
  const[residue]=await owner.client<{steps:number;input:unknown}[]>`select (select count(*)::int from bulk_job_step where job_id=${started.job.id}::uuid) steps,(select input from bulk_job where id=${started.job.id}::uuid) as input`;
  expect(residue).toEqual({steps:0,input:null});
 },240_000);

 it('retries a lock refusal instead of failing the employee, and saves each employee once',async()=>{
  const{preview,keys}=await checked(f);
  const started=await startMovementImportJob(f.a,{attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys,acknowledgeExcluded:true,locale:'en'});
  if(!('job' in started))throw new Error('expected a job');
  await ticks(started.job.id,j=>j.state==='running');
  // Another Access writer holds the tenant lock longer than the employee transaction's 1 s lock wait.
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let locked!:()=>void;const isLocked=new Promise<void>(r=>{locked=r;});
  const holder=withTenant(f.a,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);locked();await held;});
  await isLocked;
  expect(await tick()).toBe(true);
  const waited=await jobRow(started.job.id);
  expect(waited.state).toBe('running');expect(waited.transient_retries).toBeGreaterThan(0);expect(waited.steps_done).toBe(0);
  release();await holder;
  const done=await ticks(started.job.id,terminal);
  expect(done.state).toBe('completed');
  const result=(await getMovementImportJob(f.a,started.job.id)).result!;
  expect(result).toMatchObject({imported:6,failed:1});
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
  expect(answered).toEqual({already:expect.objectContaining({alreadyCommitted:true,imported:6,failed:2})});
  // A stale review is refused at the request, and the refusal is recorded on the attempt as before.
  const second=await previewMovementUpload(f.a,{name:'again.csv',content:file([FILE[3]]),resolve});
  await expect(startMovementImportJob(f.a,{...input,attemptId:second.attemptId,previewHash:'0'.repeat(64),employees:[second.preview.employees[0].key!],operationKey:randomUUID()})).rejects.toThrow(/upload it again before saving/i);
  expect((await getImportAttempt(f.a,second.attemptId))!.events.map(e=>e.kind)).toContain('failed');
 },180_000);

 it('checks the initiator again in the worker: lost company access stops the job before any employee is saved',async()=>{
  const[p]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'Scoped Fictional Admin',primaryEmail:'scoped-movement@example.test'}).returning();
  const userId=await createAppUser(f.b.tenantId,p.id,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId:f.b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const scoped:SessionContext={...f.a,userId,personId:p.id,grants:[{role:'hr_admin',companyId:f.b.companyId}]};
  const{preview,keys}=await checked(f,scoped);
  const started=await startMovementImportJob(scoped,{attemptId:preview.attemptId,previewHash:preview.previewHash,employees:keys.filter(k=>!k.endsWith('AC005')),acknowledgeExcluded:true,locale:'en'});
  if(!('job' in started))throw new Error('expected a job');
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,userId));
  const done=await ticks(started.job.id,terminal);
  expect(done.state).toBe('failed');
  const[applied]=await owner.client<{n:number}[]>`select count(*)::int n from domain_event where tenant_id=${f.b.tenantId}::uuid and event_type='movement-import.employee.applied'`;
  expect(applied.n).toBe(0);
  const[events]=await owner.client<{kinds:string[]}[]>`select array_agg(kind order by created_at) kinds from import_attempt_event where attempt_id=${preview.attemptId}::uuid`;
  expect(events.kinds).not.toContain('confirmed');
 },180_000);

 it('names its completion notice in all six catalogues',()=>{
  for(const outcome of ['completed','failed','cancelled'] as const){
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
