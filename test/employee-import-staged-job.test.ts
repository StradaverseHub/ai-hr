/** Staged employee import on the shared bulk-job kernel (migrations 9001, 9003, 9004): real PostgreSQL, real RLS,
 * real worker ticks. Release is a constant-time visibility flip; markers are settled afterwards. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import {createEmployeeImportJob,getEmployeeImportJob} from '../core/employee-import-job';
import {isTransientEmployeeImportError} from '../core/employee-import-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {LeaveDependencyUnavailable} from '../core/leave-dependency-lock';
import {checkIn} from '../core/attendance';
import {hireEmployee} from '../core/org';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {verifyTenantChain} from '../core/audit-chain';
import {dispatchNotifications} from '../core/notifications';
import type {EmployeeImportUploadInput} from '../core/employee-import-upload';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

// Force near one-row chunks so failures land after earlier chunks already committed; arm the audit chain.
vi.hoisted(()=>{process.env.EMPLOYEE_IMPORT_CHUNK_BUDGET_MS='30';process.env.EMPLOYEE_IMPORT_BATCH_TARGET_MS='5';process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});
afterAll(closeAll);

const NRIC_MIDDLE='14';
const row=(tag:string,i:number)=>({employee_code:`STG${tag}${String(i).padStart(3,'0')}`,full_name:`Staged Person ${i} ${tag}`,email:`staged-${tag.toLowerCase()}-${i}@fixture.test`,department:'Finance',hired_on:todayInKualaLumpur(),employment_type:'full_time',basic_salary:String(2500+i),ic_number:`880101${NRIC_MIDDLE}0${String(i).padStart(3,'0')}`});
const csv=(rows:Record<string,string>[])=>{const headers=Object.keys(rows[0]);return [headers.join(','),...rows.map(r=>headers.map(h=>r[h]).join(','))].join('\n')+'\n';};
const input=(rows:Record<string,string>[],companyId:string):EmployeeImportUploadInput=>({companyId,csv:csv(rows),fileName:'staged.csv',dependentsCsv:'',registers:{},allocationsCsv:''});
async function startJob(rows:Record<string,string>[],as:SessionContext=ctx){
 const text=csv(rows);
 const started=await createEmployeeImportJob(as,input(rows,b.companyId),{name:'staged.csv',content:Buffer.from(text),operationKey:randomUUID()});
 if(!('job' in started))throw new Error('unexpected replay');
 return started;
}
const tick=()=>runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});
type JobState={id:string;state:string;plan:{released?:boolean;settled?:boolean}|null;attempt_id:string|null;metrics:Record<string,number>;notified_at:Date|null};
const latest=async()=>(await owner.client<JobState[]>`select id,state,plan,attempt_id,metrics,notified_at from bulk_job order by created_at desc limit 1`)[0];
/** Runs ticks until the predicate holds or the budget ends (a transient retry waits out its short backoff). */
async function ticks(stop:(job:JobState)=>boolean,max=400){
 for(let i=0;i<max;i++){
  const job=await latest();
  if(job&&stop(job))return job;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,60));
 }
 throw new Error('job did not reach the expected state');
}
const normalCount=(tenantCtx:SessionContext)=>withTenant(tenantCtx,async tx=>{const [r]=await tx.execute<{e:number;p:number}>(sql`select (select count(*)::int from employment) e,(select count(*)::int from person) p`);return r;});
const visibleLike=(prefix:string)=>withTenant(ctx,tx=>tx.execute<{n:number}>(sql`select count(*)::int n from employment where employee_code like ${prefix+'%'}`)).then(r=>r[0].n);

describe('staged employee import job',()=>{
 it('applies in chunks, hides pending rows and their events, releases everything at once, then settles',async()=>{
  const tag='ACT';const rows=Array.from({length:6},(_,i)=>row(tag,i));
  // A person-keyed audit event with no subject employment, appended inside the hire's own transaction (as profile,
  // statutory or family writers may when the person has no visible employment yet).
  await owner.db.execute(sql`CREATE FUNCTION public.staged_person_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
    INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload) SELECT NEW.tenant_id,'person',e.person_id,'fixture.person-noted','system','{}'::jsonb FROM employment e WHERE e.id=NEW.employment_id;
    RETURN NEW; END $$`);
  await owner.db.execute(sql`CREATE TRIGGER staged_person_event AFTER INSERT ON compensation FOR EACH ROW EXECUTE FUNCTION public.staged_person_event()`);
  try{
  const baseline=await normalCount(ctx);
  const {job}=await startJob(rows);
  await ticks(j=>j.state==='running');
  const jobRow=await getEmployeeImportJob(ctx,job.id);
  expect(jobRow).toMatchObject({state:'importing',total:6,valid:6,stepsTotal:6,attemptId:expect.any(String)});
  await tick();
  const mid=await owner.client<{n:number;pending:number}[]>`select count(*)::int n,count(*) filter (where import_pending_attempt_id is not null)::int pending from employment where employee_code like 'STGACT%'`;
  expect(mid[0].n).toBeGreaterThan(0);expect(mid[0].pending).toBe(mid[0].n);
  expect(await normalCount(ctx)).toEqual(baseline);
  expect(await visibleLike('STGACT')).toBe(0);
  const inSession=(attempt:string)=>withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.import_attempt',${attempt},true)`);const[r]=await tx.execute<{n:number}>(sql`select count(*)::int n from employment where employee_code like 'STGACT%'`);return r.n;});
  expect(await inSession(jobRow.attemptId!)).toBe(mid[0].n);
  expect(await inSession(randomUUID())).toBe(0);
  const [one]=await owner.client<{id:string}[]>`select id from employment where employee_code like 'STGACT%' limit 1`;
  const reachable=()=>withTenant(ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.access_workforce_employment(${one.id}::uuid,'workforce.view') as ok`)).then(r=>r[0].ok);
  expect(await reachable()).toBe(false);
  // Direct child rows and EVERY audit event of the staged hires (with or without a subject employment) are hidden.
  const [{eids,pids}]=await owner.client<{eids:string[];pids:string[]}[]>`select array_agg(id) eids,array_agg(person_id) pids from employment where import_pending_attempt_id is not null`;
  const childRows=(table:string,col:string,ids:string[])=>withTenant(ctx,tx=>tx.execute<{n:number}>(sql.raw(`select count(*)::int n from ${table} where ${col} = any(array[${ids.map(i=>`'${i}'`).join(',')}]::uuid[])`))).then(r=>r[0].n);
  for(const [table,col,ids] of [['assignment','employment_id',eids],['compensation','employment_id',eids],['employee_statutory_my','person_id',pids],['leave_ledger','employment_id',eids],['domain_event','subject_employment_id',eids],['domain_event','aggregate_id',pids],['import_attempt_item','employment_id',eids]] as const){expect(await childRows(table,col,ids as string[])).toBe(0);}
  const [{personEvents}]=await owner.client<{personEvents:number}[]>`select count(*)::int as "personEvents" from domain_event where aggregate_id = any(${pids}::uuid[]) and subject_employment_id is null`;
  expect(personEvents).toBeGreaterThan(0);
  const auditorSees=()=>withTenant(ctx,tx=>tx.execute<{n:number}>(sql`select count(*)::int n from domain_event where aggregate_id = any(${`{${pids.join(',')}}`}::uuid[]) and subject_employment_id is null`)).then(r=>r[0].n);
  expect(await auditorSees()).toBe(0);
  // Chain verification still reads every chained row while events are staged.
  expect(await verifyTenantChain(ctx)).toMatchObject({valid:true,unchainedInsideChain:0});
  // Release: the whole import becomes visible together, before any marker is cleared.
  await ticks(j=>Boolean(j.plan?.released));
  const [marked]=await owner.client<{n:number}[]>`select count(*)::int n from employment where employee_code like 'STGACT%' and import_pending_attempt_id is not null`;
  expect(marked.n).toBeGreaterThan(0);
  expect(await visibleLike('STGACT')).toBe(6);
  expect(await reachable()).toBe(true);
  expect(await auditorSees()).toBe(personEvents);
  const done=await ticks(j=>j.state==='completed');
  const final=await getEmployeeImportJob(ctx,job.id);
  expect(final.state).toBe('completed');expect(final.imported).toBe(6);expect(final.result?.imported).toBe(6);expect(final.stepsDone).toBe(6);
  expect(Number(done.metrics.chunks)).toBeGreaterThan(1);expect(Number(done.metrics.releaseTxMs)).toBeGreaterThan(0);
  expect(await normalCount(ctx)).toEqual({e:baseline.e+6,p:baseline.p+6});
  const [after]=await owner.client<{pending:number;n:number}[]>`select count(*) filter (where import_pending_attempt_id is not null)::int pending,count(*)::int n from employment where employee_code like 'STGACT%'`;
  expect(after).toEqual({pending:0,n:6});
  const [residue]=await owner.client<{steps:number;input:unknown}[]>`select (select count(*)::int from bulk_job_step where job_id=${job.id}::uuid) steps,(select input from bulk_job where id=${job.id}::uuid) as input`;
  expect(residue).toEqual({steps:0,input:null});
  expect(await verifyTenantChain(ctx)).toMatchObject({valid:true,unchainedInsideChain:0});
  }finally{
   await owner.db.execute(sql`DROP TRIGGER IF EXISTS staged_person_event ON compensation`);
   await owner.db.execute(sql`DROP FUNCTION IF EXISTS public.staged_person_event()`);
  }
 });

 it('reserves pending employee codes and NRICs for other sessions',async()=>{
  const tag='RES';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  await startJob(rows);
  await ticks(j=>j.state==='running');
  await tick();
  const staged=await owner.client<{code:string}[]>`select employee_code as code from employment where employee_code like 'STGRES%' limit 1`;
  expect(staged.length).toBeGreaterThan(0);
  const claim=await withTenant(ctx,tx=>tx.execute(sql`select app.employee_code_claim(${b.tenantId}::uuid,${staged[0].code},null::uuid,null::uuid) as claim`));
  expect(claim[0].claim).toBe('employment');
  const conflict=await owner.client<{occupants:number}[]>`select occupants::int from people_nric_admission where tenant_id=${b.tenantId}::uuid`;
  expect(conflict.some(c=>c.occupants>0)).toBe(true);
 });

 it('resumes after a transient chunk failure without double-applying',async()=>{
  const tag='RSM';const rows=Array.from({length:4},(_,i)=>row(tag,i));
  await owner.db.execute(sql`CREATE SEQUENCE public.staged_job_fault_seq`);
  await owner.db.execute(sql`CREATE FUNCTION public.staged_job_fault_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    IF NEW.employee_code LIKE 'STGRSM%002' AND nextval('public.staged_job_fault_seq')=1 THEN RAISE EXCEPTION 'fixture retry' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
  await owner.db.execute(sql`CREATE TRIGGER staged_job_fault BEFORE INSERT ON employment FOR EACH ROW EXECUTE FUNCTION public.staged_job_fault_tg()`);
  try{
   const {job}=await startJob(rows);
   await ticks(j=>j.state==='completed',800);
   expect((await getEmployeeImportJob(ctx,job.id)).imported).toBe(4);
   const counted=await owner.client<{n:number;events:number}[]>`select (select count(*)::int from employment where employee_code like 'STGRSM%') n,(select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid and event_type='employment.hired') events`;
   expect(counted[0].n).toBe(4);expect(counted[0].events).toBe(4);
  }finally{
   await owner.db.execute(sql`DROP TRIGGER staged_job_fault ON employment`);
   await owner.db.execute(sql`DROP FUNCTION public.staged_job_fault_tg()`);
   await owner.db.execute(sql`DROP SEQUENCE public.staged_job_fault_seq`);
  }
 });

 it('resumes after a worker crash: an expired lease is reclaimed and nothing committed is repeated',async()=>{
  const tag='CRS';const rows=Array.from({length:4},(_,i)=>row(tag,i));
  const {job}=await startJob(rows);
  await ticks(j=>j.state==='running');await tick();
  // Simulate a worker that died holding the lease: another worker cannot claim until it expires.
  await owner.client`update bulk_job set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '1 hour' where id=${job.id}::uuid`;
  expect(await tick()).toBe(false);
  await owner.client`update bulk_job set lease_expires_at=now()-interval '1 second' where id=${job.id}::uuid`;
  await ticks(j=>j.state==='completed',800);
  const [counted]=await owner.client<{n:number;hired:number}[]>`select (select count(*)::int from employment where employee_code like 'STGCRS%') n,(select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid and event_type='employment.hired') hired`;
  expect(counted).toEqual({n:4,hired:4});
 });

 it('discards everything when a row is refused, leaving hired-then-voided events and releasing identifiers',async()=>{
  const tag='DSC';const rows=Array.from({length:5},(_,i)=>row(tag,i));
  await owner.db.execute(sql`CREATE FUNCTION public.staged_job_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM employment WHERE id=NEW.employment_id AND employee_code LIKE 'STGDSC%003') THEN RAISE EXCEPTION 'fixture compensation refusal'; END IF; RETURN NEW; END $$`);
  await owner.db.execute(sql`CREATE TRIGGER staged_job_refuse BEFORE INSERT ON compensation FOR EACH ROW EXECUTE FUNCTION public.staged_job_refuse()`);
  try{
   const {job}=await startJob(rows);
   await ticks(j=>j.state==='failed',800);
   const final=await getEmployeeImportJob(ctx,job.id);
   expect(final.state).toBe('failed');expect(final.error).toMatch(/row 4/);
   expect(final.errors.find(e=>e.rowNum===4)?.message).toMatch(/refused/);
   expect(final.errors.filter(e=>e.rowNum!==4).every(e=>e.message.includes('rolled back'))).toBe(true);
   expect(await withTenant(ctx,tx=>tx.execute(sql`select count(*)::int n from employment where voided_employee_code like 'STGDSC%' or employee_code like 'STGDSC%'`)).then(r=>r[0].n)).toBe(0);
   const staged=await owner.client<{id:string;voided_at:Date|null;employee_code:string|null;import_pending_attempt_id:string|null}[]>`select id,voided_at,employee_code,import_pending_attempt_id from employment e where e.voided_employee_code like 'STGDSC%'`;
   expect(staged.length).toBeGreaterThan(0);expect(staged.every(r=>r.voided_at&&r.employee_code===null&&r.import_pending_attempt_id===null)).toBe(true);
   // ADR-0157 void trail: hired then voided for every discarded hire, readable by an auditor once discarded.
   const audit=await withTenant(ctx,tx=>tx.execute<{type:string;n:number}>(sql`select event_type as type,count(*)::int n from domain_event where event_type in ('employment.hired','employment.voided') and subject_employment_id = any(${`{${staged.map(s=>s.id).join(',')}}`}::uuid[]) group by 1`));
   const byType=Object.fromEntries(audit.map(e=>[e.type,e.n]));expect(byType['employment.hired']).toBe(staged.length);expect(byType['employment.voided']).toBe(staged.length);
   const again=await withTenant(ctx,tx=>tx.execute(sql`select app.employee_code_claim(${b.tenantId}::uuid,${'STGDSC000'},null::uuid,null::uuid) as claim`));
   expect(again[0].claim).toBeNull();
   const [occupied]=await owner.client<{n:number}[]>`select count(*)::int n from people_nric_admission where tenant_id=${b.tenantId}::uuid and occupants>0 and normalized_nric like ${`880101${NRIC_MIDDLE}%`}`;
   expect(occupied.n).toBe(0);
   await owner.db.execute(sql`DROP TRIGGER staged_job_refuse ON compensation`);
   const {job:second}=await startJob(rows);
   await ticks(j=>j.id===second.id&&j.state==='completed',800);
   expect((await getEmployeeImportJob(ctx,second.id)).imported).toBe(5);
  }finally{
   await owner.db.execute(sql`DROP TRIGGER IF EXISTS staged_job_refuse ON compensation`);
   await owner.db.execute(sql`DROP FUNCTION IF EXISTS public.staged_job_refuse()`);
  }
 });

 it('reports a row-level email conflict at release and discards',async()=>{
  const tag='CNF';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  const {job}=await startJob(rows);
  await ticks(j=>j.state==='running');
  await owner.client`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Taken Name',${rows[1].email})`;
  await ticks(j=>j.state==='failed',800);
  const final=await getEmployeeImportJob(ctx,job.id);
  expect(final.errors.find(e=>e.rowNum===2)?.message).toMatch(/already used by another employee/);
  expect(await visibleLike('STGCNF')).toBe(0);
 });

 it('stops under the initiating user\'s authority when access is removed before release',async()=>{
  const tag='PRM';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  const scoped:SessionContext={...ctx,userId,grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']};
  const {job}=await startJob(rows,scoped);
  await ticks(j=>j.state==='running');
  await owner.client`delete from role_assignment where app_user_id=${userId}::uuid`;
  await ticks(j=>j.state==='failed',800);
  const [jobRow]=await owner.client<{state:string;error:string}[]>`select state,error from bulk_job where id=${job.id}::uuid`;
  expect(jobRow.state).toBe('failed');
  expect(await owner.client<{n:number}[]>`select count(*)::int n from employment where employee_code like 'STGPRM%' and voided_at is null`.then(r=>r[0].n)).toBe(0);
 });

 it('refuses release when authority is gone after every row was staged',async()=>{
  const tag='ACTP';const rows=Array.from({length:2},(_,i)=>row(tag,i));
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  const scoped:SessionContext={...ctx,userId,grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']};
  const {job}=await startJob(rows,scoped);
  await ticks(j=>j.state==='finalizing',800);
  await owner.client`delete from role_assignment where app_user_id=${userId}::uuid`;
  await ticks(j=>j.state==='failed',800);
  expect((await owner.client<{state:string}[]>`select state from bulk_job where id=${job.id}::uuid`)[0].state).toBe('failed');
  expect(await owner.client<{n:number}[]>`select count(*)::int n from employment where employee_code like 'STGACTP%' and voided_at is null`.then(r=>r[0].n)).toBe(0);
 });

 it('a normal session cannot touch the pending marker, and transient refusals are classified as retryable',async()=>{
  expect(isTransientEmployeeImportError(new LeaveDependencyUnavailable('busy'))).toBe(true);
  expect(isTransientEmployeeImportError(new LeaveDependencyUnavailable('changed'))).toBe(false);
  expect(isTransientEmployeeImportError(Object.assign(new Error('x'),{code:'40P01'}))).toBe(true);
  expect(isTransientEmployeeImportError(Object.assign(new Error('x'),{code:'23505'}))).toBe(false);
  const tag='GRD';const rows=[row(tag,0)];
  await startJob(rows);
  await ticks(j=>j.state==='running');
  await tick();
  const {attempt_id}=await latest();
  await expect(withTenant(ctx,async(tx:Tx)=>{await tx.execute(sql`select set_config('app.import_attempt',${attempt_id},true)`);return tx.execute(sql`update employment set import_pending_attempt_id=null where employee_code like 'STGGRD%'`);})).rejects.toThrow();
  // Neither the release nor the settle/discard owners can be reached as an ordinary session for another's attempt.
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.import_settle(${b.tenantId}::uuid,${attempt_id}::uuid,10)`))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.import_discard_batch(${b.tenantId}::uuid,${attempt_id}::uuid,${b.adminUserId}::uuid,'fixture reason',10)`))).rejects.toThrow();
 });

 it('runs alongside clock-in, login and an Access writer with no errors and no long waits, all-or-nothing throughout',async()=>{
  const tag='CON';const rows=Array.from({length:30},(_,i)=>row(tag,i));
  const hired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-05',person:{fullName:'Clock Probe',primaryEmail:'clock-probe@fixture.test'},employeeCode:'CLOCK001'});
  const lat:Record<string,number[]>={login:[],access:[],clock:[]};const errors:string[]=[];let running=true;const seen=new Set<number>();
  const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(running){const s=Date.now();try{await fn(i++);lat[name]?.push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error).message).slice(0,160)}`);}await new Promise(r=>setTimeout(r,gap));}};
  const probes=Promise.all([
   loop('login',50,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[b.tenantId,b.adminUserId])),
   loop('access',50,()=>withTenant(ctx,async(tx:Tx)=>{await lockAccessConfigurationTx(tx,b.tenantId);await tx.execute(sql`select 1`);})),
   loop('clock',300,i=>checkIn(ctx,{employmentId:hired.employmentId,date:new Date(Date.parse('2026-06-01')+i*86400000).toISOString().slice(0,10),time:'09:00'})),
   loop('visible',40,async()=>{seen.add(await visibleLike('STGCON'));}),
  ]);
  try{
   const {job}=await startJob(rows);
   const start=Date.now();
   await ticks(j=>j.state==='completed',4000);
   expect(Date.now()-start).toBeLessThan(120000);
   expect((await getEmployeeImportJob(ctx,job.id)).imported).toBe(30);
  }finally{running=false;await probes;}
  expect(errors).toEqual([]);
  expect([...seen].every(n=>n===0||n===30)).toBe(true);
  for(const name of ['login','access','clock'] as const){expect(lat[name].length).toBeGreaterThan(0);expect(Math.max(...lat[name])).toBeLessThan(10000);}
  const punches=await owner.client<{d:string;n:number}[]>`select a.attendance_date::text d,count(*)::int n from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${hired.employmentId}::uuid and p.direction='in' group by 1 having count(*)<>1`;
  expect(punches).toEqual([]);
 },180000);

 it('finishes across separate protected-worker processes with no double-apply',async()=>{
  const tag='PRC';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  const {job}=await startJob(rows);
  for(let i=0;i<30;i++){
   const [{state,notified}]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${job.id}::uuid`;
   if(state==='completed'&&notified)break;
   const run=spawnSync(process.execPath,['--import','tsx','scripts/bank-import-runner.ts','--once'],{cwd:process.cwd(),env:{...process.env,EMPLOYEE_IMPORT_CHUNK_BUDGET_MS:'30'},encoding:'utf8',timeout:60000});
   expect(run.status,run.stderr).toBe(0);
  }
  expect(await getEmployeeImportJob(ctx,job.id)).toMatchObject({state:'completed',imported:3});
  const [counted]=await owner.client<{n:number;hired:number}[]>`select (select count(*)::int from employment where employee_code like 'STGPRC%' and import_pending_attempt_id is null) n,(select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid and event_type='employment.hired') hired`;
  expect(counted).toEqual({n:3,hired:3});
  // The protected worker reported which kinds it serves.
  const [beat]=await owner.client<{kinds:string[]}[]>`select kinds from bulk_job_worker order by beat_at desc limit 1`;
  expect(beat.kinds).toContain('employee_import');
 },180000);

 it('applies direct superiors after every employee, as their own steps, and releases the reporting line',async()=>{
  const tag='SUP';
  const manager={...row(tag,0),direct_superior:''};
  const report={...row(tag,1),direct_superior:row(tag,0).employee_code};
  const {job}=await startJob([report,manager]);
  await ticks(j=>j.state==='running');
  const kinds=await owner.client<{kind:string}[]>`select kind from bulk_job_step where job_id=${job.id}::uuid order by seq`;
  expect(kinds.map(k=>k.kind)).toEqual(['employee','employee','superior']);
  await ticks(j=>j.state==='completed',800);
  const [line]=await owner.client<{n:number}[]>`select count(*)::int n from reporting_line r join employment s on s.id=r.subordinate_employment_id join employment m on m.id=r.manager_employment_id where s.employee_code=${report.employee_code} and m.employee_code=${manager.employee_code} and s.import_pending_attempt_id is null`;
  expect(line.n).toBe(1);
 });

 it('notifies the person who started it, in-app, with the outcome and a link to Import History',async()=>{
  await setModule(b.tenantId,'notifications','active');
  const starter=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-05',person:{fullName:'Import Starter',primaryEmail:'import-starter@fixture.test'},employeeCode:'STARTER1'});
  const userId=await createAppUser(b.tenantId,starter.personId,'hr_admin');
  const as:SessionContext={...ctx,userId,personId:starter.personId,grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']};
  const notices=async()=>owner.client<{kind:string;title:string;body:string;link_path:string;recipient_employment_id:string}[]>`select kind,title,body,link_path,recipient_employment_id from notification where tenant_id=${b.tenantId}::uuid and kind='bulk-job.finished' order by created_at`;
  const {job}=await startJob([row('NTF',0)],as);
  await ticks(j=>j.id===job.id&&j.state==='completed'&&j.notified_at!==null,800);
  await dispatchNotifications(await entitledCtx(b),{});
  expect(await notices()).toEqual([{kind:'bulk-job.finished',title:'bulkJobs.notification.employeeImport.completed.title',body:'bulkJobs.notification.employeeImport.completed.body',link_path:'/admin/personnel/import/history',recipient_employment_id:starter.employmentId}]);
  // A refused file (an unknown column) is a failed outcome, told to the same person once.
  const failed=await startJob([{...row('NTF',1),bogus_column:'x'}],as);
  await ticks(j=>j.id===failed.job.id&&j.state==='failed'&&j.notified_at!==null,800);
  await dispatchNotifications(await entitledCtx(b),{});await dispatchNotifications(await entitledCtx(b),{});
  const all=await notices();
  expect(all).toHaveLength(2);
  expect(all[1]).toMatchObject({title:'bulkJobs.notification.employeeImport.failed.title',body:'bulkJobs.notification.employeeImport.failed.body',recipient_employment_id:starter.employmentId});
  // A forged finished event cannot address anyone: only the job's own recorded notice event resolves a recipient.
  await withTenant(as,tx=>tx.execute(sql`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${b.tenantId}::uuid,'bulk-job',${job.id}::uuid,'bulk-job.finished','user',${userId}::uuid,'{"kind":"employee_import","outcome":"completed"}'::jsonb)`));
  await dispatchNotifications(await entitledCtx(b),{});
  expect(await notices()).toHaveLength(2);
 });

 it('keeps a queued import visibly waiting while no worker serves its kind',async()=>{
  await owner.client`delete from bulk_job_worker`;
  const {job}=await startJob([row('QUE',0)]);
  expect(job).toMatchObject({state:'queued',worker:'unavailable'});
  await owner.client`insert into bulk_job_worker(id,kinds,host,pid) values(gen_random_uuid(),'{employee_import}','fixture',1)`;
  expect(await getEmployeeImportJob(ctx,job.id)).toMatchObject({state:'queued',worker:'running'});
  await owner.client`update bulk_job_worker set beat_at=now()-interval '5 minutes'`;
  expect(await getEmployeeImportJob(ctx,job.id)).toMatchObject({worker:'unavailable'});
 });
});
