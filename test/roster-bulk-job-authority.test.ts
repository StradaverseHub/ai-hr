/**
 * Roster bulk jobs keep the roster's authority at every point the background conversion (22b594902, ec60b788f) moved it
 * to: a non-administrator is refused at every enqueue door with nothing queued (core/roster-bulk-job.ts), and a
 * creator whose administrator role is withdrawn after enqueue is stopped by the worker before the first roster row,
 * and, separately, at finalize before the operation's summary event (the kernel's lease fence plus
 * core/roster-bulk-worker.ts). Real PostgreSQL, real RLS, real worker ticks; fictional people only.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {runBulkJobTick,type BulkJobHandler} from '../core/bulk-job-worker';
import {rosterBulkJobHandler} from '../core/roster-bulk-worker';
import {enqueueRosterAssignJob,enqueueRosterCopyJob,enqueueRosterGenerateJob,enqueueRosterImportJob} from '../core/roster-bulk-job';
import {createShift,RosterAdminRequiredError} from '../core/roster';

let b:Base,admin:SessionContext;
// One step per chunk transaction, so the job can be observed between its writes and its finalize.
const handlers:BulkJobHandler[]=[{...rosterBulkJobHandler,chunkBudgetMs:1,maxStepsPerChunk:1}];
const dates=['2027-03-08','2027-03-09'];
const LOST='Your access to this job changed, so it was stopped.';
const terminal=(state:string)=>['completed','failed','cancelled'].includes(state);

async function tickUntil(id:string,done:(state:string)=>boolean){
 for(let i=0;i<2000;i++){
  const [row]=await owner.client<{state:string}[]>`select state from bulk_job where id=${id}::uuid`;
  if(done(row.state))return row.state;
  if(!await runBulkJobTick(owner.client,{handlers}))await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error('roster job did not reach the expected state');
}
const jobError=async(id:string)=>(await owner.client<{error:string|null}[]>`select error from bulk_job where id=${id}::uuid`)[0].error;
const rosterJobs=()=>owner.client<{id:string}[]>`select id from bulk_job where tenant_id=${b.tenantId}::uuid and kind='roster_bulk'`;
async function rosterRows(ids:string[]){
 const [row]=await owner.client<{n:number}[]>`select count(*)::int n from roster_assignment where employment_id=any(${ids}::uuid[])`;
 return row.n;
}
async function events(type:string){
 const [row]=await owner.client<{n:number}[]>`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and event_type=${type}`;
 return row.n;
}
async function makeEmp(name:string){
 const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:`rba_${randomUUID()}@t.local`}).returning({id:schema.person.id});
 const [e]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:p.id,companyId:b.companyId,employeeCode:`RA${randomUUID().slice(0,6).toUpperCase()}`,hiredOn:'2020-01-01'})
  .returning({id:schema.employment.id});
 return e.id;
}
const mkShift=()=>createShift(admin,{companyId:b.companyId,name:'Fictional Day',code:`D${randomUUID().slice(0,4).toUpperCase()}`,startTime:'09:00:00',endTime:'18:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});
/** A second, real HR administrator login whose role can be withdrawn without touching the base administrator. */
async function delegatedAdmin(){
 const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional roster administrator',primaryEmail:`rbadmin_${randomUUID()}@t.local`}).returning({id:schema.person.id});
 const userId=await createAppUser(b.tenantId,p.id,'hr_admin');
 const ctx:SessionContext={...admin,userId,personId:p.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 return{ctx,withdraw:()=>owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,userId))};
}

beforeAll(async()=>{await migrateTestDb();});
afterAll(async()=>{await closeAll();});
beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);});

describe('roster bulk job authority',()=>{
 it('refuses a non-administrator at every roster enqueue door and queues nothing',async()=>{
  const shift=await mkShift(),employmentId=await makeEmp('Fictional Worker');
  const employee:SessionContext={...admin,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const doors:(()=>unknown)[]=[
   ()=>enqueueRosterAssignJob(employee,{companyId:b.companyId,employmentIds:[employmentId],shiftDates:dates,brush:shift.id}),
   ()=>enqueueRosterAssignJob(employee,{companyId:b.companyId,employmentIds:[employmentId],shiftDates:dates,brush:'rest'}),
   ()=>enqueueRosterCopyJob(employee,{companyId:b.companyId,employmentIds:[employmentId],sourceFrom:'2027-03-01',sourceTo:'2027-03-07',targetFrom:'2027-03-08'}),
   ()=>enqueueRosterGenerateJob(employee,{companyId:b.companyId,input:{shiftId:shift.id,employmentIds:[employmentId],from:'2027-03-01',to:'2027-03-14'}}),
   ()=>enqueueRosterImportJob(employee,{companyId:b.companyId,month:'2027-03',csvText:'Employee ID\n',fileName:'fictional.csv'}),
  ];
  for(const door of doors)await expect((async()=>door())()).rejects.toBeInstanceOf(RosterAdminRequiredError);
  expect(await rosterJobs()).toEqual([]);
  expect(await rosterRows([employmentId])).toBe(0);
 });

 it('stops a job whose creator lost the administrator role after enqueue, before any roster row or audit event',async()=>{
  const shift=await mkShift(),people=[await makeEmp('Fictional Worker 1'),await makeEmp('Fictional Worker 2')];
  const creator=await delegatedAdmin();
  const job=await enqueueRosterAssignJob(creator.ctx,{companyId:b.companyId,employmentIds:people,shiftDates:dates,brush:shift.id});
  await creator.withdraw();
  expect(await tickUntil(job.id,terminal)).toBe('failed');
  expect(await jobError(job.id)).toBe(LOST);
  expect(await rosterRows(people)).toBe(0);
  expect(await events('roster.manual-changes')).toBe(0);
  expect(await events('roster.bulk.assigned')).toBe(0);
 });

 it('re-checks the creator at finalize: rows written under the role stay, and the summary event is never written after it is withdrawn',async()=>{
  const shift=await mkShift(),people=[await makeEmp('Fictional Worker 1'),await makeEmp('Fictional Worker 2')];
  const creator=await delegatedAdmin();
  const job=await enqueueRosterAssignJob(creator.ctx,{companyId:b.companyId,employmentIds:people,shiftDates:dates,brush:shift.id});
  expect(await tickUntil(job.id,state=>state==='finalizing'||terminal(state))).toBe('finalizing');
  // Every write step committed under the creator's then-current role, each with its own duty-guard event.
  expect(await rosterRows(people)).toBe(people.length*dates.length);
  expect(await events('roster.manual-changes')).toBe(people.length);
  expect(await events('roster.bulk.assigned')).toBe(0);
  await creator.withdraw();
  expect(await tickUntil(job.id,terminal)).toBe('failed');
  expect(await jobError(job.id)).toBe(LOST);
  expect(await events('roster.bulk.assigned')).toBe(0);
 });

 it('completes the same job for a creator who keeps the role (the refusals above are the withdrawal, not the fixture)',async()=>{
  const shift=await mkShift(),people=[await makeEmp('Fictional Worker 1'),await makeEmp('Fictional Worker 2')];
  const creator=await delegatedAdmin();
  const job=await enqueueRosterAssignJob(creator.ctx,{companyId:b.companyId,employmentIds:people,shiftDates:dates,brush:shift.id});
  expect(await tickUntil(job.id,terminal)).toBe('completed');
  expect(await rosterRows(people)).toBe(people.length*dates.length);
  expect(await events('roster.bulk.assigned')).toBe(1);
 });
});
