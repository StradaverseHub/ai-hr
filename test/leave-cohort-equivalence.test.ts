/**
 * Leave cohort writers in batches (core/leave-cohort-run.ts, core/leave-cohort-worker.ts): the background job and
 * the batched timers must leave EXACTLY what the old single-transaction runs left, on a populated fixture with
 * several leave types (service-banded Annual Leave with carry cap and a 31 March expiry, Sick Leave, a Study Leave
 * whose table starts in August), joiners during the year, leavers before and during it, leave taken in the carry
 * window, and a prior year already opened. Each arm runs in a fresh database built by the same fixture; the
 * comparison maps ids to employee names and leave type codes.
 */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {accrueEarnedLeave,expireCarriedLeave,openLeaveYear} from '../core/leave';
import {runLeaveGeneration} from '../core/leave-generation';
import {accrueEarnedLeaveInBatches,expireCarriedLeaveInBatches} from '../core/leave-cohort-run';
import {createEarnedAccrualJob,createLeaveGenerationJob,readLeaveCohortJob} from '../core/leave-cohort-job';
import {earnedAccrualJobHandler,leaveGenerationJobHandler} from '../core/leave-cohort-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);

const EMPLOYEES=45;
const HIRED=['2019-03-04','2021-07-15','2023-01-02','2025-05-20','2026-02-10','2026-07-01'];
/** The owner-run timers' system context (scripts/accrue-earned.ts, scripts/expire-carry.ts). */
const systemCtx=():SessionContext=>({tenantId:b.tenantId,roles:['hr_admin'],entitlementsExempt:'sweeps'} as SessionContext);
const addType=async(code:string,name:string)=>{
 const [t]=await owner.db.insert(schema.leaveType).values({tenantId:b.tenantId,code,name,paid:true,allowNegativeBalance:true}).returning({id:schema.leaveType.id});
 return t.id;
};
const post=(employmentId:string,leaveTypeId:string,entryType:'debit'|'adjustment',days:number,effectiveOn:string)=>
 owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId,leaveTypeId,entryType,days:days.toFixed(2),effectiveOn});

/** The same tenant, built the same way in every arm. `earned`: Annual Leave earns monthly instead of a lump grant. */
async function fixture(earned:boolean){
 await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,serviceBands:[{fromYears:0,toYears:3,days:12},{fromYears:3,toYears:null,days:16}],validFrom:'2019-01-01'});
 await owner.db.update(schema.leaveType).set({carryForwardMax:'5',carryForwardExpiryMonth:3,carryForwardExpiryDay:31,...(earned?{accrualMethod:'earned_monthly'}:{})}).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
 const sick=await addType('SICK','Sick Leave');
 await seedEntitlement(adminCtx(b),{leaveTypeId:sick,annualDays:14,validFrom:'2019-01-01'});
 const study=await addType('STD','Study Leave');
 await seedEntitlement(adminCtx(b),{leaveTypeId:study,annualDays:5,validFrom:'2026-08-01'});
 const people:{employmentId:string;i:number}[]=[];
 for(let i=0;i<EMPLOYEES;i++){
  const {employmentId}=await hireEmployee(adminCtx(b),{person:{fullName:`Equiv ${String(i).padStart(2,'0')}`,primaryEmail:`eq_${randomUUID().slice(0,8)}@t.local`},
   companyId:b.companyId,departmentId:i%2?b.deptA:b.deptB,employmentType:'full_time',hiredOn:HIRED[i%HIRED.length]});
  people.push({employmentId,i});
 }
 // Leavers: one before 2026, one during it.
 for(const p of people){
  if(p.i%15===7)await owner.db.update(schema.employment).set({terminatedOn:'2025-06-30'}).where(eq(schema.employment.id,p.employmentId));
  if(p.i%15===11)await owner.db.update(schema.employment).set({terminatedOn:'2026-09-30'}).where(eq(schema.employment.id,p.employmentId));
 }
 // The prior year, already processed the old way, then leave taken in 2025 and inside the 2026 carry window.
 if(earned)await accrueEarnedLeave(adminCtx(b),{asOf:'2025-12-31'});
 else await openLeaveYear(adminCtx(b),{year:2025});
 for(const p of people){
  if(p.i%3===0)await post(p.employmentId,b.annualLeaveTypeId,'debit',-(1+p.i%4),'2025-09-15');
  if(p.i%4===1)await post(p.employmentId,b.annualLeaveTypeId,'debit',-(p.i%3+0.5),'2026-02-16');
  if(p.i%5===2)await post(p.employmentId,sick,'debit',-2,'2025-11-03');
 }
 return {sick,study,people};
}

const LEAVE_EVENTS=['leave-year.opened','leave.earned-accrual.run','leave.carry-forward.swept','leave-generation.run'];
/** Everything a run leaves behind, with ids replaced by employee names, type codes and fixed labels. */
async function snapshot(){
 const names=new Map<string,string>();
 for(const r of await owner.client<{id:string;name:string}[]>`select e.id,p.full_name as name from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid`)names.set(r.id,r.name);
 for(const r of await owner.client<{id:string;code:string}[]>`select id,code from leave_type where tenant_id=${b.tenantId}::uuid`)names.set(r.id,'type:'+r.code);
 for(const r of await owner.client<{id:string}[]>`select id from leave_generation_run where tenant_id=${b.tenantId}::uuid`)names.set(r.id,'RUN');
 names.set(b.tenantId,'TENANT');names.set(b.companyId,'COMPANY');names.set(b.adminUserId,'ADMIN');
 const map=(v:unknown):unknown=>{
  if(typeof v==='string')return names.get(v)??v;
  if(Array.isArray(v))return v.map(map).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
  // Keys sorted: a result read back from jsonb has its own key order, and arrays are compared as sets.
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='runId').sort(([x],[y])=>x.localeCompare(y)).map(([k,x])=>[k,map(x)]));
  return v;
 };
 const ledger=await owner.client`select l.employment_id,l.leave_type_id,l.entry_type,l.days::text,l.effective_on::text,l.reason,l.source_request_id from leave_ledger l where l.tenant_id=${b.tenantId}::uuid`;
 const events=await owner.client`select event_type,aggregate_type,aggregate_id,actor_type,actor_id,subject_employment_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type=any(${LEAVE_EVENTS}) order by occurred_at,sequence`;
 const runs=await owner.client`select actor_user_id,leave_year,leave_type_ids,target_mode,criteria,employment_ids,employees_selected,granted,skipped,forfeits,employees_passed,employees_failed from leave_generation_run where tenant_id=${b.tenantId}::uuid`;
 const items=await owner.client`select employment_id,leave_type_id,outcome,days::text,carry::text,forfeit::text,below_statutory_floor from leave_generation_run_item where tenant_id=${b.tenantId}::uuid`;
 const balances=await owner.client`select employment_id,leave_type_id,sum(days)::text as balance from leave_ledger where tenant_id=${b.tenantId}::uuid group by 1,2`;
 // Events keep their order (the engines append in a fixed order); everything else is a set.
 return {state:{ledger:map([...ledger]),events:[...events].map(e=>map({...e})),runs:map([...runs]),items:map([...items]),balances:map([...balances])},map};
}
const tick=()=>runBulkJobTick(owner.client,{handlers:[leaveGenerationJobHandler,earnedAccrualJobHandler]});
async function runJob(id:string){
 for(let i=0;i<2000;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
  if(['completed','failed','cancelled'].includes(row.state)&&row.notified)return row.state;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error('job did not finish');
}
const stepsOf=async(id:string)=>(await owner.client<{steps_total:number;metrics:Record<string,number>}[]>`select steps_total,metrics from bulk_job where id=${id}::uuid`)[0];

describe('leave cohort writers in batches leave exactly what the single-transaction runs left',()=>{
 it('Generate Entitlement (lump Annual Leave with carry cap) and the carry-forward expiry timer',async()=>{
  // Arm A: the synchronous runs.
  await fixture(false);
  const syncResult=await runLeaveGeneration(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  const syncExpiry=await expireCarriedLeave(systemCtx(),{today:'2026-04-01'});
  const {state:sync,map:syncMap}=await snapshot();
  // Arm B: the background job, then the batched timer.
  await resetDb();b=await seedBase();await fixture(false);
  const job=await createLeaveGenerationJob(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  expect(job.state).toBe('queued');
  expect(await runJob(job.id)).toBe('completed');
  const done=await readLeaveCohortJob(adminCtx(b),job.id);
  const batched=await expireCarriedLeaveInBatches(systemCtx(),{today:'2026-04-01'},{batchSize:7});
  const {state:after,map:jobMap}=await snapshot();
  expect(batched).toEqual(syncExpiry);
  expect(syncExpiry.swept).toBeGreaterThan(0);expect(syncExpiry.forfeited).toBeGreaterThan(0);
  const {runId:_a,...syncRest}=syncResult as typeof syncResult&{runId?:string};
  const {runId:_b,...jobRest}=(done!.result as typeof syncResult&{runId?:string});
  expect(typeof _b).toBe('string');void _a;
  expect(jobMap(jobRest)).toEqual(syncMap(syncRest));
  expect(syncResult.granted).toBeGreaterThan(EMPLOYEES);expect(syncResult.forfeits).toBeGreaterThan(0);
  expect(after).toEqual(sync);
  expect(after.events.map(e=>(e as {event_type:string}).event_type)).toEqual(['leave-year.opened','leave-year.opened','leave-generation.run','leave.carry-forward.swept']); // 2025 setup, then the run
  expect((await stepsOf(job.id)).steps_total).toBeGreaterThan(2);
 },240_000);

 it('Generate Entitlement with earned Annual Leave (year-open, then the earned hand-over) and Run Earned Accrual',async()=>{
  await fixture(true);
  const syncResult=await runLeaveGeneration(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  const syncAccrual=await accrueEarnedLeave(adminCtx(b),{asOf:'2026-12-31',leaveTypeIds:[b.annualLeaveTypeId]});
  const {state:sync,map:syncMap}=await snapshot();
  await resetDb();b=await seedBase();await fixture(true);
  const gen=await createLeaveGenerationJob(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  expect(await runJob(gen.id)).toBe('completed');
  const genDone=await readLeaveCohortJob(adminCtx(b),gen.id);
  const acc=await createEarnedAccrualJob(adminCtx(b),{asOf:'2026-12-31',leaveTypeIds:[b.annualLeaveTypeId]});
  expect(await runJob(acc.id)).toBe('completed');
  const accDone=await readLeaveCohortJob(adminCtx(b),acc.id);
  const {state:after,map:jobMap}=await snapshot();
  expect(accDone!.result).toEqual({granted:syncAccrual.granted,forfeits:syncAccrual.forfeits});
  expect(syncAccrual.granted).toBeGreaterThan(0);
  expect(syncResult.accrual?.posted).toBeGreaterThan(0);
  const strip=(r:unknown)=>{const {runId:_r,...rest}=r as {runId?:string};void _r;return rest;};
  expect(jobMap(strip(genDone!.result))).toEqual(syncMap(strip(syncResult)));
  expect(after).toEqual(sync);
  expect(after.events.map(e=>(e as {event_type:string}).event_type)).toEqual(['leave.earned-accrual.run','leave-year.opened','leave.earned-accrual.run','leave-generation.run','leave.earned-accrual.run']); // 2025 setup first
 },240_000);

 it('the monthly accrual timer in batches equals the unscoped run (system actor, unscoped audit payload)',async()=>{
  await fixture(true);
  const syncRes=await accrueEarnedLeave(systemCtx(),{asOf:'2026-06-30'});
  const {state:sync}=await snapshot();
  await resetDb();b=await seedBase();await fixture(true);
  const batched=await accrueEarnedLeaveInBatches(systemCtx(),{asOf:'2026-06-30'},{batchSize:6});
  const {state:after}=await snapshot();
  expect(batched).toEqual({granted:syncRes.granted,forfeits:syncRes.forfeits});
  expect(syncRes.granted).toBeGreaterThan(0);expect(syncRes.forfeits).toBeGreaterThan(0);
  expect(after).toEqual(sync);
  // The fixture's 2025 run, then the measured one: unscoped, by the system actor.
  expect(after.events).toHaveLength(2);
  expect(after.events[1]).toMatchObject({event_type:'leave.earned-accrual.run',actor_type:'system',payload:{asOf:'2026-06-30',employmentIds:[]}});
 },240_000);
});

describe('leave cohort jobs keep the refusals and never surface Busy',()=>{
 it('refuses the whole accrual before writing when an information-only correction protects the period',async()=>{
  const {people}=await fixture(true);
  await owner.client`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload)
   values(${b.tenantId}::uuid,'employment',${people[3].employmentId}::uuid,'employment.information.corrected','system',${people[3].employmentId}::uuid,${JSON.stringify({effectiveOn:'2026-12-01'})}::jsonb)`;
  await expect(accrueEarnedLeave(adminCtx(b),{asOf:'2026-06-30'})).rejects.toThrow(/information-only correction/);
  const [{n:before}]=await owner.client`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid`;
  const job=await createEarnedAccrualJob(adminCtx(b),{asOf:'2026-06-30'});
  expect(await runJob(job.id)).toBe('failed');
  expect((await readLeaveCohortJob(adminCtx(b),job.id))!.error).toMatch(/information-only correction/);
  const [{n:after}]=await owner.client`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid`;
  expect(after).toBe(before);
 },120_000);

 it('waits for an employee another writer holds, then completes with nothing left unprocessed',async()=>{
  const {people}=await fixture(true);
  const job=await createEarnedAccrualJob(adminCtx(b),{asOf:'2026-06-30'});
  const holder=await owner.client.reserve();
  try{
   await holder`begin`;
   await holder`select pg_advisory_xact_lock(hashtextextended(${`leave-dependency-employment:${b.tenantId}:${[...people].map(p=>p.employmentId).sort()[0]}`},0))`;
   for(let i=0;i<6;i++)await tick();
   const [row]=await owner.client`select state,transient_retries from bulk_job where id=${job.id}::uuid`;
   expect(row.state).toBe('running');expect(row.transient_retries).toBeGreaterThan(0);
   await holder`rollback`;
  }finally{holder.release();}
  await owner.client`update bulk_job set not_before=null where id=${job.id}::uuid`;
  expect(await runJob(job.id)).toBe('completed');
  expect(await readLeaveCohortJob(adminCtx(b),job.id)).toMatchObject({state:'completed',failedEmployees:0,error:null});
  void withTenant;
 },120_000);
});
