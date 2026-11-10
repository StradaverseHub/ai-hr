/** Staged employee import job (migration 9001): real PostgreSQL, real RLS, real worker ticks. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import {createEmployeeImportJob,getEmployeeImportJob} from '../core/employee-import-job';
import {isTransientEmployeeImportError,runEmployeeImportTick} from '../core/employee-import-worker';
import {LeaveDependencyUnavailable} from '../core/leave-dependency-lock';
import {checkIn} from '../core/attendance';
import {hireEmployee} from '../core/org';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import type {EmployeeImportUploadInput} from '../core/employee-import-upload';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

// Force near one-row chunks so failures land after earlier chunks already committed.
vi.hoisted(()=>{process.env.EMPLOYEE_IMPORT_CHUNK_BUDGET_MS='30';});
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});
afterAll(closeAll);

const NRIC_MIDDLE='14';
const row=(tag:string,i:number)=>({employee_code:`STG${tag}${String(i).padStart(3,'0')}`,full_name:`Staged Person ${i} ${tag}`,email:`staged-${tag.toLowerCase()}-${i}@fixture.test`,department:'Finance',hired_on:todayInKualaLumpur(),employment_type:'full_time',basic_salary:String(2500+i),ic_number:`880101${NRIC_MIDDLE}0${String(i).padStart(3,'0')}`});
const csv=(rows:Record<string,string>[])=>{const headers=Object.keys(rows[0]);return [headers.join(','),...rows.map(r=>headers.map(h=>r[h]).join(','))].join('\n')+'\n';};
const input=(rows:Record<string,string>[],companyId:string):EmployeeImportUploadInput=>({companyId,csv:csv(rows),fileName:'staged.csv',dependentsCsv:'',registers:{},allocationsCsv:''});
async function startJob(rows:Record<string,string>[]){
 const text=csv(rows);
 return createEmployeeImportJob(ctx,input(rows,b.companyId),{name:'staged.csv',content:Buffer.from(text),operationKey:randomUUID()});
}
/** Runs ticks until the predicate holds or the budget ends. */
async function ticks(stop:(state:string)=>boolean,max=400){
 for(let i=0;i<max;i++){
  const [job]=await owner.client<{state:string}[]>`select state from employee_import_job order by created_at desc limit 1`;
  if(job&&stop(job.state))return;
  await runEmployeeImportTick(owner.client);
 }
 throw new Error('job did not reach the expected state');
}
const normalCount=(tenantCtx:SessionContext,extra='')=>withTenant(tenantCtx,async tx=>{const [r]=await tx.execute<{e:number;p:number}>(sql.raw(`select (select count(*)::int from employment ${extra}) e,(select count(*)::int from person) p`));return r;});
const ownerRows=async(attemptWhere='')=>[...await owner.client.unsafe<{employee_code:string|null;voided_at:Date|null;import_pending_attempt_id:string|null}[]>(`select employee_code,voided_at,import_pending_attempt_id from employment e where e.employee_code like 'STG%' or e.voided_employee_code like 'STG%' ${attemptWhere}`)];

describe('staged employee import job',()=>{
 it('applies in chunks, hides pending rows from normal sessions, and activates atomically',async()=>{
  const tag='ACT';const rows=Array.from({length:6},(_,i)=>row(tag,i));
  const baseline=await normalCount(ctx);
  const {job}=await startJob(rows);
  await ticks(s=>s==='importing');
  const jobRow=await getEmployeeImportJob(ctx,job.id);
  expect(jobRow).toMatchObject({state:'importing',total:6,valid:6,stepsTotal:6,attemptId:expect.any(String)});
  // Apply one chunk at a time and look between chunks.
  await runEmployeeImportTick(owner.client);
  const mid=await owner.client<{n:number;pending:number}[]>`select count(*)::int n,count(*) filter (where import_pending_attempt_id is not null)::int pending from employment where employee_code like 'STGACT%'`;
  expect(mid[0].n).toBeGreaterThan(0);expect(mid[0].pending).toBe(mid[0].n);
  // Normal session: employment and person pending rows invisible; counts unchanged.
  expect(await normalCount(ctx)).toEqual(baseline);
  expect(await withTenant(ctx,tx=>tx.execute(sql`select count(*)::int n from employment where employee_code like 'STGACT%'`)).then(r=>r[0].n)).toBe(0);
  // Import session sees its own pending rows; another attempt id sees none.
  const inSession=(attempt:string)=>withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.import_attempt',${attempt},true)`);const[r]=await tx.execute<{n:number}>(sql`select count(*)::int n from employment where employee_code like 'STGACT%'`);return r.n;});
  expect(await inSession(jobRow.attemptId!)).toBe(mid[0].n);
  expect(await inSession(randomUUID())).toBe(0);
  // Pending rows are not reachable by id either, even with admin grants.
  const [one]=await owner.client<{id:string}[]>`select id from employment where employee_code like 'STGACT%' limit 1`;
  expect(await withTenant(ctx,tx=>tx.execute(sql`select app.access_workforce_employment(${one.id}::uuid,'workforce.view') as ok`)).then(r=>r[0].ok)).toBe(false);
  // Direct child rows the hire wrote are hidden from a normal session but readable by the owner.
  const [{eids,pids}]=await owner.client<{eids:string[];pids:string[]}[]>`select array_agg(id) eids,array_agg(person_id) pids from employment where import_pending_attempt_id is not null`;
  const childRows=(table:string,col:string,ids:string[])=>withTenant(ctx,tx=>tx.execute<{n:number}>(sql.raw(`select count(*)::int n from ${table} where ${col} = any(array[${ids.map(i=>`'${i}'`).join(',')}]::uuid[])`))).then(r=>r[0].n);
  for(const [table,col,ids] of [['assignment','employment_id',eids],['compensation','employment_id',eids],['employee_statutory_my','person_id',pids],['leave_ledger','employment_id',eids],['domain_event','subject_employment_id',eids],['import_attempt_item','employment_id',eids]] as const){expect(await childRows(table,col,ids as string[])).toBe(0);}
  const [{ownerAssignments}]=await owner.client<{ownerAssignments:number}[]>`select count(*)::int as "ownerAssignments" from assignment where employment_id = any(${eids}::uuid[])`;expect(ownerAssignments).toBeGreaterThan(0);
  await ticks(s=>s==='completed');
  const final=await getEmployeeImportJob(ctx,job.id);
  expect(final.state).toBe('completed');expect(final.imported).toBe(6);expect(final.result?.imported).toBe(6);expect(final.stepsDone).toBe(6);
  const [metrics]=await owner.client<{chunks:number}[]>`select chunks from employee_import_job where id=${job.id}::uuid`;expect(metrics.chunks).toBeGreaterThan(1);
  expect(await normalCount(ctx)).toEqual({e:baseline.e+6,p:baseline.p+6});
  const [after]=await owner.client<{pending:number;n:number}[]>`select count(*) filter (where import_pending_attempt_id is not null)::int pending,count(*)::int n from employment where employee_code like 'STGACT%'`;
  expect(after).toEqual({pending:0,n:6});
  // Steps deleted and PII payload cleared at the terminal state.
  const [residue]=await owner.client<{steps:number;input:unknown}[]>`select (select count(*)::int from employee_import_step where job_id=${job.id}::uuid) steps,(select input from employee_import_job where id=${job.id}::uuid) as input`;
  expect(residue).toEqual({steps:0,input:null});
 });

 it('reserves pending employee codes and NRICs for other sessions',async()=>{
  const tag='RES';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  await startJob(rows);
  await ticks(s=>s==='importing');
  await runEmployeeImportTick(owner.client);
  const staged=await owner.client<{code:string}[]>`select employee_code as code from employment where employee_code like 'STGRES%' limit 1`;
  expect(staged.length).toBeGreaterThan(0);
  const claim=await withTenant(ctx,tx=>tx.execute(sql`select app.employee_code_claim(${b.tenantId}::uuid,${staged[0].code},null::uuid,null::uuid) as claim`));
  expect(claim[0].claim).toBe('employment');
  const nric=await withTenant(ctx,tx=>tx.execute(sql`select occupants::int n from people_nric_admission where tenant_id=${b.tenantId}::uuid`)).catch(()=>null);
  const conflict=await owner.client<{occupants:number}[]>`select occupants::int from people_nric_admission where tenant_id=${b.tenantId}::uuid`;
  expect(nric===null||conflict.length>=1).toBe(true);
  // Two independent reservation signals: the employment code index (asserted by claim above) and the NRIC counter.
  expect(conflict.some(c=>c.occupants>0)).toBe(true);
 });

 it('resumes after a transient chunk failure without double-applying',async()=>{
  const tag='RSM';const rows=Array.from({length:4},(_,i)=>row(tag,i));
  // A trigger that throws a retryable serialization failure for the third row, once.
  await owner.db.execute(sql`CREATE SEQUENCE public.staged_job_fault_seq`);
  await owner.db.execute(sql`CREATE FUNCTION public.staged_job_fault_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    IF NEW.employee_code LIKE 'STGRSM%002' AND nextval('public.staged_job_fault_seq')=1 THEN RAISE EXCEPTION 'fixture retry' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
  await owner.db.execute(sql`CREATE TRIGGER staged_job_fault BEFORE INSERT ON employment FOR EACH ROW EXECUTE FUNCTION public.staged_job_fault_tg()`);
  try{
   const {job}=await startJob(rows);
   await ticks(s=>s==='completed',800);
   const final=await getEmployeeImportJob(ctx,job.id);
   expect(final.imported).toBe(4);
   const counted=await owner.client<{n:number;events:number}[]>`select (select count(*)::int from employment where employee_code like 'STGRSM%') n,(select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid and event_type='employment.hired') events`;
   expect(counted[0].n).toBe(4);expect(counted[0].events).toBe(4);
  }finally{
   await owner.db.execute(sql`DROP TRIGGER staged_job_fault ON employment`);
   await owner.db.execute(sql`DROP FUNCTION public.staged_job_fault_tg()`);
   await owner.db.execute(sql`DROP SEQUENCE public.staged_job_fault_seq`);
  }
 });

 it('discards everything when a row is refused, leaving hired-then-voided events and releasing identifiers',async()=>{
  const tag='DSC';const rows=Array.from({length:5},(_,i)=>row(tag,i));
  await owner.db.execute(sql`CREATE FUNCTION public.staged_job_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM employment WHERE id=NEW.employment_id AND employee_code LIKE 'STGDSC%003') THEN RAISE EXCEPTION 'fixture compensation refusal'; END IF; RETURN NEW; END $$`);
  await owner.db.execute(sql`CREATE TRIGGER staged_job_refuse BEFORE INSERT ON compensation FOR EACH ROW EXECUTE FUNCTION public.staged_job_refuse()`);
  try{
   const {job}=await startJob(rows);
   await ticks(s=>s==='failed',800);
   const final=await getEmployeeImportJob(ctx,job.id);
   expect(final.state).toBe('failed');expect(final.error).toMatch(/row 4/);
   expect(final.errors.find(e=>e.rowNum===4)?.message).toMatch(/refused/);
   expect(final.errors.filter(e=>e.rowNum!==4).every(e=>e.message.includes('rolled back'))).toBe(true);
   // Nothing visible, nothing left pending.
   expect(await withTenant(ctx,tx=>tx.execute(sql`select count(*)::int n from employment where voided_employee_code like 'STGDSC%' or employee_code like 'STGDSC%'`)).then(r=>r[0].n)).toBe(0);
   const staged=await owner.client<{voided_at:Date|null;employee_code:string|null;import_pending_attempt_id:string|null}[]>`select voided_at,employee_code,import_pending_attempt_id from employment e where e.voided_employee_code like 'STGDSC%'`;
   expect(staged.length).toBeGreaterThan(0);expect(staged.every(r=>r.voided_at&&r.employee_code===null&&r.import_pending_attempt_id===null)).toBe(true);
   // hired-then-void event pair for every discarded staged hire.
   const events=await owner.client<{type:string;n:number}[]>`select event_type as type,count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and event_type in ('employment.hired','employment.voided') and subject_employment_id in (select id from employment where voided_employee_code like 'STGDSC%') group by 1`;
   const byType=Object.fromEntries(events.map(e=>[e.type,e.n]));expect(byType['employment.hired']).toBe(staged.length);expect(byType['employment.voided']).toBe(staged.length);
   // Employee codes are free again and the NRIC counter is released.
   const again=await withTenant(ctx,tx=>tx.execute(sql`select app.employee_code_claim(${b.tenantId}::uuid,${'STGDSC000'},null::uuid,null::uuid) as claim`));
   expect(again[0].claim).toBeNull();
   const [occupied]=await owner.client<{n:number}[]>`select count(*)::int n from people_nric_admission where tenant_id=${b.tenantId}::uuid and occupants>0 and normalized_nric like ${`880101${NRIC_MIDDLE}%`}`;
   expect(occupied.n).toBe(0);
   // A corrected file can be re-imported with the same identifiers.
   await owner.db.execute(sql`DROP TRIGGER staged_job_refuse ON compensation`);
   const {job:second}=await startJob(rows);
   await ticks(s=>s==='completed',800);
   expect((await getEmployeeImportJob(ctx,second.id)).imported).toBe(5);
  }finally{
   await owner.db.execute(sql`DROP TRIGGER IF EXISTS staged_job_refuse ON compensation`);
   await owner.db.execute(sql`DROP FUNCTION IF EXISTS public.staged_job_refuse()`);
  }
 });

 it('reports a row-level email conflict at activation and discards',async()=>{
  const tag='CNF';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  await startJob(rows);
  await ticks(s=>s==='importing');
  // Another admin hires someone using the same email while the import applies.
  await owner.client`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Taken Name',${rows[1].email})`;
  await ticks(s=>s==='failed',800);
  const [job]=await owner.client<{id:string}[]>`select id from employee_import_job order by created_at desc limit 1`;
  const final=await getEmployeeImportJob(ctx,job.id);
  expect(final.state).toBe('failed');
  expect(final.errors.find(e=>e.rowNum===2)?.message).toMatch(/already used by another employee/);
  expect(await withTenant(ctx,tx=>tx.execute(sql`select count(*)::int n from employment where employee_code like 'STGCNF%'`)).then(r=>r[0].n)).toBe(0);
 });

 it('stops under the initiating user\'s authority when access is removed before activation',async()=>{
  const tag='PRM';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  // The initiating user is a real scoped login, so removing the role removes authority.
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  const scoped:SessionContext={...ctx,userId,grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']};
  const text=csv(rows);
  const {job}=await createEmployeeImportJob(scoped,input(rows,b.companyId),{name:'staged.csv',content:Buffer.from(text),operationKey:randomUUID()});
  await ticks(s=>s==='importing');
  await owner.client`delete from role_assignment where app_user_id=${userId}::uuid`;
  await ticks(s=>s==='failed',800);
  const [jobRow]=await owner.client<{state:string;imported:number}[]>`select state,imported from employee_import_job where id=${job.id}::uuid`;
  expect(jobRow.state).toBe('failed');
  expect(await owner.client<{n:number}[]>`select count(*)::int n from employment where employee_code like 'STGPRM%' and voided_at is null`.then(r=>r[0].n)).toBe(0);
 });

 it('refuses activation when authority is gone after every row was staged',async()=>{
  const tag='ACTP';const rows=Array.from({length:2},(_,i)=>row(tag,i));
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  const scoped:SessionContext={...ctx,userId,grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']};
  const {job}=await createEmployeeImportJob(scoped,input(rows,b.companyId),{name:'staged.csv',content:Buffer.from(csv(rows)),operationKey:randomUUID()});
  await ticks(s=>s==='activating',800);
  await owner.client`delete from role_assignment where app_user_id=${userId}::uuid`;
  await ticks(s=>s==='failed',800);
  const [row_]=await owner.client<{state:string;error:string|null}[]>`select state,error from employee_import_job where id=${job.id}::uuid`;
  expect(row_.state).toBe('failed');
  expect(await owner.client<{n:number}[]>`select count(*)::int n from employment where employee_code like 'STGACTP%' and voided_at is null`.then(r=>r[0].n)).toBe(0);
 });

 it('a normal session cannot touch the pending marker, and transient refusals are classified as retryable',async()=>{
  expect(isTransientEmployeeImportError(new LeaveDependencyUnavailable('busy'))).toBe(true);
  expect(isTransientEmployeeImportError(new LeaveDependencyUnavailable('changed'))).toBe(false);
  expect(isTransientEmployeeImportError(Object.assign(new Error('x'),{code:'40P01'}))).toBe(true);
  expect(isTransientEmployeeImportError(Object.assign(new Error('x'),{code:'23505'}))).toBe(false);
  const tag='GRD';const rows=[row(tag,0)];
  const {job}=await startJob(rows);
  await ticks(s=>s==='importing');
  await runEmployeeImportTick(owner.client);
  const [{attempt_id}]=await owner.client<{attempt_id:string}[]>`select attempt_id from employee_import_job where id=${job.id}::uuid`;
  // Even inside the import session, a direct write that clears the marker is refused.
  await expect(withTenant(ctx,async(tx:Tx)=>{await tx.execute(sql`select set_config('app.import_attempt',${attempt_id},true)`);return tx.execute(sql`update employment set import_pending_attempt_id=null where employee_code like 'STGGRD%'`);})).rejects.toThrow();
 });
 it('runs alongside clock-in, login and an Access writer with no errors and no long waits',async()=>{
  const tag='CON';const rows=Array.from({length:30},(_,i)=>row(tag,i));
  const hired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-05',person:{fullName:'Clock Probe',primaryEmail:'clock-probe@fixture.test'},employeeCode:'CLOCK001'});
  const lat:Record<string,number[]>={login:[],access:[],clock:[]};const errors:string[]=[];let running=true;
  const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(running){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error).message).slice(0,160)}`);}await new Promise(r=>setTimeout(r,gap));}};
  const probes=Promise.all([
   loop('login',50,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[b.tenantId,b.adminUserId])),
   loop('access',50,()=>withTenant(ctx,async(tx:Tx)=>{await lockAccessConfigurationTx(tx,b.tenantId);await tx.execute(sql`select 1`);})),
   loop('clock',300,i=>checkIn(ctx,{employmentId:hired.employmentId,date:new Date(Date.parse('2026-06-01')+i*86400000).toISOString().slice(0,10),time:'09:00'})),
  ]);
  try{
   const {job}=await startJob(rows);
   const start=Date.now();
   await ticks(s=>s==='completed',4000);
   expect(Date.now()-start).toBeLessThan(120000);
   const final=await getEmployeeImportJob(ctx,job.id);expect(final.imported).toBe(30);
  }finally{running=false;await probes;}
  expect(errors).toEqual([]);
  for(const name of ['login','access','clock'] as const){expect(lat[name].length).toBeGreaterThan(0);expect(Math.max(...lat[name])).toBeLessThan(10000);}
  const punches=await owner.client<{d:string;n:number}[]>`select a.attendance_date::text d,count(*)::int n from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${hired.employmentId}::uuid and p.direction='in' group by 1 having count(*)<>1`;
  expect(punches).toEqual([]);
 },180000);
 it('finishes across separate worker processes with no double-apply',async()=>{
  const tag='PRC';const rows=Array.from({length:3},(_,i)=>row(tag,i));
  const {job}=await startJob(rows);
  for(let i=0;i<12;i++){
   const [{state}]=await owner.client<{state:string}[]>`select state from employee_import_job where id=${job.id}::uuid`;
   if(state==='completed')break;
   const run=spawnSync(process.execPath,['--import','tsx','scripts/employee-import-runner.ts','--once'],{cwd:process.cwd(),env:{...process.env,EMPLOYEE_IMPORT_CHUNK_BUDGET_MS:'30'},encoding:'utf8',timeout:60000});
   expect(run.status,run.stderr).toBe(0);
  }
  const final=await getEmployeeImportJob(ctx,job.id);
  expect(final).toMatchObject({state:'completed',imported:3});
  const [counted]=await owner.client<{n:number;hired:number}[]>`select (select count(*)::int from employment where employee_code like 'STGPRC%' and import_pending_attempt_id is null) n,(select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid and event_type='employment.hired') hired`;
  expect(counted).toEqual({n:3,hired:3});
 },120000);
});
