import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {DatabaseAdmissionError} from '../db/admission';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {LeaveDependencyUnavailable} from '../core/leave-dependency-lock';
import {applyLeaveImportRowTx,type LeaveImportPlanRow} from '../core/leave-import';
import {createLeaveImportJob,readLeaveImportJob} from '../core/leave-import-job';
import {isTransientLeaveImportError,runLeaveImportTick} from '../core/leave-import-worker';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {LeaveImportRecord} from '../lib/leave-import-schema';

let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);

async function hire(name:string){
 const {employmentId}=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`job_${randomUUID().slice(0,8)}@t.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01',grantLeaveTypes:[{id:b.annualLeaveTypeId,code:'ANNUAL'}]});
 const [row]=await owner.db.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,employmentId));
 return {employmentId,code:row.code!};
}
const line=(code:string,days:string,on='2026-02-02'):LeaveImportRecord=>({employee_id:code,leave_type:'ANNUAL',transaction_type:'adjustment',days,effective_date:on});
async function ticksUntil(id:string,wanted:string){
 for(let i=0;i<40;i++){
  const [row]=await owner.client`select state from leave_import_job where id=${id}::uuid`;
  if(row.state===wanted)return;
  await runLeaveImportTick(owner.client);
 }
 throw new Error('Job did not reach '+wanted);
}
const ledgerDays=async(employmentId:string)=>(await owner.db.select({days:schema.leaveLedger.days}).from(schema.leaveLedger).where(and(eq(schema.leaveLedger.employmentId,employmentId),eq(schema.leaveLedger.reason,'Imported (leave migration)')))).map(r=>Number(r.days)).sort();
const summaries=async(batch:string)=>(await owner.client`select count(*)::int as n from domain_event where aggregate_id=${batch}::uuid and event_type='leave.import.completed'`)[0].n as number;

describe('leave ledger import as a background job',()=>{
 it('writes nothing in the request, then imports every valid row with one summary event',async()=>{
  const first=await hire('First'),second=await hire('Second');
  const job=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'3.00'),line(second.code,'4.00'),line('NO-SUCH-CODE','1.00')],source:{kind:'file',name:'leave.csv',format:'csv'}});
  expect(job.state).toBe('queued');
  expect(await ledgerDays(first.employmentId)).toEqual([]);
  await ticksUntil(job.id,'completed');
  const done=await readLeaveImportJob(adminCtx(b),job.id);
  expect(done).toMatchObject({state:'completed',done:3,total:3,result:{imported:2,skipped:0,failed:[],totalRows:3}});
  expect(await ledgerDays(first.employmentId)).toEqual([3]);
  expect(await ledgerDays(second.employmentId)).toEqual([4]);
  const [row]=await owner.client`select batch_id from leave_import_job where id=${job.id}::uuid`;
  expect(await summaries(row.batch_id)).toBe(1);
 });
 it('resumes from its checkpoint and writes a row once when the checkpoint was lost after the commit',async()=>{
  const first=await hire('Resume A'),second=await hire('Resume B');
  const job=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'2.00'),line(second.code,'6.00')]});
  await ticksUntil(job.id,'importing');
  const [row]=await owner.client`select plan,records from leave_import_job where id=${job.id}::uuid`;
  const plan=row.plan as LeaveImportPlanRow[],records=row.records as LeaveImportRecord[];
  // The crash this simulates: the first row committed, the worker died before recording its checkpoint.
  await withTenant(adminCtx(b),tx=>applyLeaveImportRowTx(tx,adminCtx(b),plan[0],records[plan[0].result.rowNum-1]));
  await ticksUntil(job.id,'completed');
  expect((await readLeaveImportJob(adminCtx(b),job.id))?.result).toMatchObject({imported:1,skipped:1,failed:[]});
  expect(await ledgerDays(first.employmentId)).toEqual([2]);
  expect(await ledgerDays(second.employmentId)).toEqual([6]);
 });
 it('records a row that no longer matches its plan and carries on with the rest',async()=>{
  const first=await hire('Changed A'),second=await hire('Changed B');
  const job=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'1.00'),line(second.code,'2.00')]});
  await ticksUntil(job.id,'importing');
  await owner.client`update leave_import_job set plan=jsonb_set(plan,'{0,dedupeKey}','"stale"') where id=${job.id}::uuid`;
  await ticksUntil(job.id,'completed');
  const result=(await readLeaveImportJob(adminCtx(b),job.id))?.result;
  expect(result).toMatchObject({imported:1,skipped:0});
  expect(result?.failed).toHaveLength(1);
  expect(result?.failed[0]).toMatchObject({rowNum:1,employeeRef:first.code});
  expect(await ledgerDays(first.employmentId)).toEqual([]);
  expect(await ledgerDays(second.employmentId)).toEqual([2]);
 });
 it('rejoins the running job instead of starting a second one',async()=>{
  const first=await hire('Double');
  const created=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'1.00')]});
  const again=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'9.00')]});
  expect(again.id).toBe(created.id);
  const [count]=await owner.client`select count(*)::int as n from leave_import_job`;
  expect(count.n).toBe(1);
 });
 it('shows a job only to the person who started it',async()=>{
  const first=await hire('Isolated');
  const created=await createLeaveImportJob(adminCtx(b),{records:[line(first.code,'1.00')]});
  const other={...adminCtx(b),userId:randomUUID()};
  await expect(readLeaveImportJob(other,created.id)).resolves.toBeNull();
  await expect(readLeaveImportJob(adminCtx(b),'not-a-uuid')).resolves.toBeNull();
 });
 it('treats only load refusals as temporary',()=>{
  expect(isTransientLeaveImportError(new LeaveDependencyUnavailable('busy'))).toBe(true);
  expect(isTransientLeaveImportError(new LeaveDependencyUnavailable('changed'))).toBe(false);
  expect(isTransientLeaveImportError(new DatabaseAdmissionError('queue-timeout'))).toBe(true);
  expect(isTransientLeaveImportError(Object.assign(new Error('x'),{code:'40P01'}))).toBe(true);
  expect(isTransientLeaveImportError(Object.assign(new Error('x'),{code:'23505'}))).toBe(false);
 });
});
