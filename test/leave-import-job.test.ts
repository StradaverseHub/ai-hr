/** Leave ledger import on the shared bulk-job kernel (kind leave_ledger, draft 5030): real PostgreSQL, real RLS,
 * real worker ticks. The job must leave the same ledger, row outcomes and summary event as the synchronous import. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {DatabaseAdmissionError} from '../db/admission';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {LeaveDependencyUnavailable} from '../core/leave-dependency-lock';
import {applyLeaveImportRowTx,commitLeaveImport,type LeaveImportPlanRow} from '../core/leave-import';
import {activeLeaveImportJob,createLeaveImportJob,readLeaveImportJob} from '../core/leave-import-job';
import {isTransientLeaveImportError,leaveImportJobHandler} from '../core/leave-import-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {LeaveImportRecord} from '../lib/leave-import-schema';

let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);

async function hire(name:string,hiredOn='2024-01-01'){
 const email=`job_${randomUUID().slice(0,8)}@t.local`;
 const {employmentId}=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:email},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn,grantLeaveTypes:[{id:b.annualLeaveTypeId,code:'ANNUAL'}]});
 const [row]=await owner.db.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,employmentId));
 return {employmentId,code:row.code!,email};
}
const line=(code:string,days:string,on='2026-02-02',type='adjustment'):LeaveImportRecord=>({employee_id:code,leave_type:'ANNUAL',transaction_type:type,days,effective_date:on});
const tick=()=>runBulkJobTick(owner.client,{handlers:[leaveImportJobHandler]});
async function ticksUntil(id:string,wanted:string[]){
 for(let i=0;i<400;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(wanted.includes(row.state)&&(!['completed','failed','cancelled'].includes(row.state)||row.notified))return row.state;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,30));
 }
 throw new Error('Job did not reach '+wanted.join('/'));
}
const ledgerDays=async(employmentId:string)=>(await owner.db.select({days:schema.leaveLedger.days}).from(schema.leaveLedger).where(and(eq(schema.leaveLedger.employmentId,employmentId),eq(schema.leaveLedger.reason,'Imported (leave migration)')))).map(r=>Number(r.days)).sort();
/** Everything the import leaves behind, keyed by employee name so two fresh databases compare. */
async function snapshot(){
 const ledger=await owner.client`select p.full_name,l.entry_type,l.days::text,l.effective_on::text,l.reason from leave_ledger l
  join employment e on e.id=l.employment_id join person p on p.id=e.person_id where l.tenant_id=${b.tenantId}::uuid and l.reason='Imported (leave migration)'
  order by 1,2,3,4`;
 const events=await owner.client`select event_type,aggregate_type,actor_type,actor_id::text=${b.adminUserId} as by_admin,payload from domain_event
  where tenant_id=${b.tenantId}::uuid and event_type='leave.import.completed' order by occurred_at`;
 const balances=await owner.client`select p.full_name,sum(l.days)::text as balance from leave_ledger l join employment e on e.id=l.employment_id join person p on p.id=e.person_id
  where l.tenant_id=${b.tenantId}::uuid group by 1 order by 1`;
 return {ledger:[...ledger],events:[...events],balances:[...balances]};
}

describe('leave ledger import as a background job on the shared kernel',()=>{
 it('writes nothing in the request, then imports every valid row with one summary event and one notice',async()=>{
  const first=await hire('First'),second=await hire('Second');
  const job=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'3.00'),line(second.code,'4.00'),line('NO-SUCH-CODE','1.00')],source:{kind:'file',name:'leave.csv',format:'csv'}});
  expect(job).toMatchObject({state:'queued',done:0});
  expect(await ledgerDays(first.employmentId)).toEqual([]);
  await ticksUntil(job.id,['completed']);
  const done=await readLeaveImportJob(adminCtx(b),job.id);
  expect(done).toMatchObject({state:'completed',done:3,total:3,result:{imported:2,skipped:0,failed:[],totalRows:3}});
  expect(await ledgerDays(first.employmentId)).toEqual([3]);
  expect(await ledgerDays(second.employmentId)).toEqual([4]);
  const events=await owner.client`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='leave.import.completed'`;
  expect(events.map(e=>e.payload)).toEqual([{imported:2,failed:0,skipped:0,totalRows:3,source:{kind:'file',name:'leave.csv',format:'csv'}}]);
  const notices=await owner.client`select actor_id,payload from domain_event where aggregate_type='bulk-job' and aggregate_id=${job.id}::uuid`;
  expect(notices).toHaveLength(1);expect(notices[0].payload).toEqual({kind:'leave_ledger',outcome:'completed'});
  // Inputs (employee references) are gone once the job has finished; the outcome stays.
  const [row]=await owner.client`select input,(select count(*)::int from bulk_job_step s where s.job_id=j.id) as steps from bulk_job j where id=${job.id}::uuid`;
  expect(row).toMatchObject({input:null,steps:0});
 });

 it('leaves the same ledger, balances, row outcomes and summary event as the synchronous import',async()=>{
  const file=async()=>{
   const a=await hire('Equiv A'),c=await hire('Equiv C'),d=await hire('Equiv D');
   // Opening balance, carry-forward credit, a correcting negative adjustment, a duplicate row inside the file, an
   // unknown employee, a bad sign and a row that was already imported before the file was submitted.
   await withTenant(adminCtx(b),tx=>tx.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:d.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'adjustment',days:'2.00',effectiveOn:'2026-03-01',reason:'Imported (leave migration)'}));
   // Also referenced by e-mail (upper-cased) and by a lower-cased code, which the per-row re-check resolves from
   // its narrowed read exactly as the whole-file plan does from every employment.
   return [line(a.code,'5.50','2026-01-15'),line(a.code,'-1.00','2026-02-01'),line(c.code,'3.00','2026-01-10'),line(c.code,'3.00','2026-01-10'),
    line('NOBODY','1.00'),line(c.code,'-2.00','2026-02-02','accrual'),line(d.code,'2.00','2026-03-01'),line(d.code,'7.00','2026-01-01','adjustment'),
    line(a.email.toUpperCase(),'1.25','2026-04-01'),line(d.code.toLowerCase(),'0.75','2026-04-02'),line(c.email,'2.00','2026-03-01','accrual')];
  };
  const syncResult=await commitLeaveImport(adminCtx(b),{records:await file(),source:{kind:'paste'}});
  const syncState=await snapshot();
  // Independent of the comparison: every row the whole-file validation accepted is written by the narrowed per-row
  // re-check (a re-check that resolved differently would refuse the row as changed), including the e-mail and
  // lower-case references, and the prior duplicate is found in the narrowed ledger read and skipped.
  expect(syncResult.failed).toEqual([]);
  const written=syncState.ledger.map(r=>`${r.full_name}|${r.entry_type}|${r.days}`);
  expect(written).toEqual(expect.arrayContaining(['Equiv A|adjustment|1.25','Equiv D|adjustment|0.75','Equiv C|accrual|2.00']));
  await resetDb();b=await seedBase();
  const job=await createLeaveImportJob(adminCtx(b),{records:await file(),source:{kind:'paste'}});
  await ticksUntil(job.id,['completed']);
  const jobResult=(await readLeaveImportJob(adminCtx(b),job.id))!.result;
  expect(jobResult).toEqual(syncResult);
  expect(syncResult.imported).toBeGreaterThan(0);expect(syncResult.skipped).toBeGreaterThan(0);
  const jobState=await snapshot();
  expect(jobState).toEqual(syncState);
  expect(jobState.ledger.length).toBeGreaterThan(3);
 });

 it('skips a row another writer saved before the job reached it, as the synchronous import does',async()=>{
  const first=await hire('Resume A'),second=await hire('Resume B');
  const records=[line(first.code,'2.00'),line(second.code,'6.00')];
  const job=await createLeaveImportJob(adminCtx(b),{records});
  await ticksUntil(job.id,['running']);
  const [step]=await owner.client<{payload:LeaveImportPlanRow}[]>`select payload from bulk_job_step where job_id=${job.id}::uuid and state='pending' order by seq limit 1`;
  await withTenant(adminCtx(b),tx=>applyLeaveImportRowTx(tx,adminCtx(b),step.payload,records[step.payload.result.rowNum-1]));
  await ticksUntil(job.id,['completed']);
  expect((await readLeaveImportJob(adminCtx(b),job.id))?.result).toMatchObject({imported:1,skipped:1,failed:[]});
  expect(await ledgerDays(first.employmentId)).toEqual([2]);
  expect(await ledgerDays(second.employmentId)).toEqual([6]);
 });

 it('records a row that no longer matches its plan and carries on with the rest',async()=>{
  const first=await hire('Changed A'),second=await hire('Changed B');
  const job=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'1.00'),line(second.code,'2.00')]});
  await ticksUntil(job.id,['running']);
  // The planned row goes stale. The hardened kernel seals every step (5013) and would stop the job on a bare payload
  // edit, so the fixture reseals the step as the queue owner; the row then reaches the import's own re-check.
  await owner.client`update bulk_job_step set payload=jsonb_set(payload,'{dedupeKey}','"stale"') where job_id=${job.id}::uuid and seq=0`;
  const resealed=await owner.client`update app.bulk_job_step_seal z set digest=app.bulk_job_step_digest(s.kind,s.row_num,s.payload,s.state,s.result,s.error)
   from bulk_job_step s where s.job_id=z.job_id and s.seq=z.seq and z.job_id=${job.id}::uuid and z.seq=0 returning z.seq`;
  expect(resealed).toHaveLength(1);
  await ticksUntil(job.id,['completed']);
  const result=(await readLeaveImportJob(adminCtx(b),job.id))?.result;
  expect(result).toMatchObject({imported:1,skipped:0});
  expect(result?.failed).toEqual([{rowNum:1,employeeRef:first.code,message:'Leave source is unavailable; review it again.'}]);
  expect(await ledgerDays(first.employmentId)).toEqual([]);
  expect(await ledgerDays(second.employmentId)).toEqual([2]);
  const [event]=await owner.client`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='leave.import.completed'`;
  expect(event.payload).toMatchObject({imported:1,failed:1,skipped:0,totalRows:2});
 });

 it('waits for an employee another writer holds instead of failing the row (never Busy)',async()=>{
  const first=await hire('Held');
  const job=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'4.00')]});
  await ticksUntil(job.id,['running']);
  const key=`leave-dependency-employment:${b.tenantId}:${first.employmentId}`;
  const holder=await owner.client.reserve();
  try{
   await holder`begin`;await holder`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
   for(let i=0;i<3;i++)await tick();
   const [busy]=await owner.client`select state,transient_retries from bulk_job where id=${job.id}::uuid`;
   expect(busy.state).toBe('running');expect(busy.transient_retries).toBeGreaterThan(0);
   await holder`rollback`;
  }finally{holder.release();}
  await owner.client`update bulk_job set not_before=null where id=${job.id}::uuid`;
  await ticksUntil(job.id,['completed']);
  expect((await readLeaveImportJob(adminCtx(b),job.id))?.result).toMatchObject({imported:1,failed:[]});
  expect(await ledgerDays(first.employmentId)).toEqual([4]);
 });

 it('rejoins the running job instead of starting a second one',async()=>{
  const first=await hire('Double');
  const created=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'1.00')]});
  const again=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'9.00')]});
  expect(again.id).toBe(created.id);
  expect((await activeLeaveImportJob(adminCtx(b)))?.id).toBe(created.id);
  const [count]=await owner.client`select count(*)::int as n from bulk_job where kind='leave_ledger'`;
  expect(count.n).toBe(1);
 });

 it('shows a job only to the person who started it, and refuses a non-administrator',async()=>{
  const first=await hire('Isolated');
  const created=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'1.00')]});
  const otherUser=await createAppUser(b.tenantId,null,'hr_admin');
  const other:SessionContext={...adminCtx(b),userId:otherUser};
  await expect(readLeaveImportJob(other,created.id)).resolves.toBeNull();
  await expect(activeLeaveImportJob(other)).resolves.toBeNull();
  await expect(readLeaveImportJob(adminCtx(b),'not-a-uuid')).resolves.toBeNull();
  await expect(createLeaveImportJob({...adminCtx(b),roles:['employee']},{records:[line(first.code,'1.00')]})).rejects.toThrow(/HR administrators/);
 });

 it('treats only load refusals as temporary',()=>{
  expect(isTransientLeaveImportError(new LeaveDependencyUnavailable('busy'))).toBe(true);
  expect(isTransientLeaveImportError(new LeaveDependencyUnavailable('changed'))).toBe(false);
  expect(isTransientLeaveImportError(new DatabaseAdmissionError('queue-timeout'))).toBe(true);
  expect(isTransientLeaveImportError(Object.assign(new Error('x'),{code:'40P01'}))).toBe(true);
  expect(isTransientLeaveImportError(Object.assign(new Error('x'),{code:'23505'}))).toBe(false);
 });

 it('keeps the rows already saved when stopped, and still records one summary event',async()=>{
  const people=await Promise.all(['S1','S2','S3','S4','S5','S6'].map(n=>hire('Stop '+n)));
  const job=await createLeaveImportJob(adminCtx(b),{records:people.map(p=>line(p.code,'1.00'))});
  await ticksUntil(job.id,['running']);
  // One chunk with a tiny budget so the stop lands between rows.
  await runBulkJobTick(owner.client,{handlers:[{...leaveImportJobHandler,chunkBudgetMs:1}]});
  const [{n:saved}]=await owner.client`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid and reason='Imported (leave migration)'`;
  expect(saved).toBeGreaterThan(0);expect(saved).toBeLessThan(6);
  await owner.client`update bulk_job set cancel_requested_at=now() where id=${job.id}::uuid`;
  expect(await ticksUntil(job.id,['cancelled'])).toBe('cancelled');
  const [{n:after}]=await owner.client`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid and reason='Imported (leave migration)'`;
  expect(after).toBe(saved);
  const events=await owner.client`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='leave.import.completed'`;
  expect(events.map(e=>e.payload)).toEqual([{imported:saved,failed:0,skipped:0,totalRows:6,source:null}]);
  expect(await readLeaveImportJob(adminCtx(b),job.id)).toMatchObject({state:'failed',result:null});
  void sql;
 });
});
