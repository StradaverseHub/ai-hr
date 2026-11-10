/**
 * Leave cohort writers in batches (core/leave-cohort-run.ts, core/leave-cohort-worker.ts): the background job and
 * the batched timers must leave EXACTLY what the old single-transaction runs left, on a populated fixture with
 * several leave types (service-banded Annual Leave with carry cap and a 31 March expiry, Sick Leave, a Study Leave
 * whose table starts in August), joiners during the year, leavers before and during it, leave taken in the carry
 * window, and a prior year already opened. Each arm runs in a fresh database built by the same fixture; the
 * comparison maps ids to employee names and leave type codes.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql as sqlTag} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {accrueEarnedLeave,expireCarriedLeave,openLeaveYear,CARRY_FORFEIT_REASON_EXPIRY as CARRY_EXPIRY} from '../core/leave';
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

/** A real failure part-way, injected the way a database refusal would arrive: a test trigger on the ledger. */
async function failInserts(name:string,where:string){
 await owner.client.unsafe(`create or replace function public.${name}() returns trigger language plpgsql as $$ begin if ${where} then raise exception 'injected failure for this test'; end if; return new; end $$`);
 await owner.client.unsafe(`create trigger ${name} before insert on leave_ledger for each row execute function public.${name}()`);
}
async function dropFailure(name:string){await owner.client.unsafe(`drop trigger if exists ${name} on leave_ledger; drop function if exists public.${name}()`);}
const employmentNamed=async(name:string)=>(await owner.client<{id:string}[]>`select e.id from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid and p.full_name=${name}`)[0].id;
const nameOf=async(id:string)=>(await owner.client<{name:string}[]>`select p.full_name as name from employment e join person p on p.id=e.person_id where e.id=${id}::uuid`)[0].name;
const typeCode=async(code:string)=>(await owner.client<{id:string}[]>`select id from leave_type where tenant_id=${b.tenantId}::uuid and code=${code}`)[0].id;
async function tickUntil(id:string,done:()=>Promise<boolean>){
 for(let i=0;i<4000;i++){if(await done())return;if(!await tick())await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error('condition never reached');
}
const appliedSteps=async(id:string,kind:string)=>(await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job_step where job_id=${id}::uuid and kind=${kind} and state='applied'`)[0].n;
const visibleLedgerRows=()=>withTenant(adminCtx(b),async tx=>Number((await tx.execute<{n:number}>(sqlTag`select count(*)::int as n from leave_ledger`))[0].n));

describe('Generate Entitlement stays all-or-nothing on the job (staged batches, one release)',()=>{
 it('an earned batch refused part-way keeps the entitlement and none of the earned days, as the old run did; nobody sees a staged row',async()=>{
  // Job arm first: its plan names an employee in the LAST batches, so earlier earned batches are already staged.
  await fixture(true);
  const before=await visibleLedgerRows();
  const job=await createLeaveGenerationJob(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  await tickUntil(job.id,async()=>(await owner.client`select 1 from bulk_job where id=${job.id}::uuid and state='running'`).length>0);
  const [{plan}]=await owner.client<{plan:{generation:{targets:string[]}}}[]>`select plan from bulk_job where id=${job.id}::uuid`;
  const targets=plan.generation.targets;
  const victim=await nameOf(targets[targets.length-2]);
  const al=b.annualLeaveTypeId;
  await failInserts('test_fail_earned',`new.employment_id='${await employmentNamed(victim)}' and new.leave_type_id='${al}' and new.entry_type='accrual'`);
  let jobResult:unknown,after:Awaited<ReturnType<typeof snapshot>>;
  try{
   // Mid-run: the year-open is staged and several earned batches too, and an ordinary session sees none of it.
   await tickUntil(job.id,async()=>await appliedSteps(job.id,'accrue')>=3);
   expect(await visibleLedgerRows()).toBe(before);
   const [{staged}]=await owner.client<{staged:number}[]>`select count(*)::int as staged from leave_ledger where tenant_id=${b.tenantId}::uuid and stage_id is not null`;
   expect(staged).toBeGreaterThan(EMPLOYEES);
   expect(await runJob(job.id)).toBe('completed');
   jobResult=(await readLeaveCohortJob(adminCtx(b),job.id))!.result;
   after=await snapshot();
  }finally{await dropFailure('test_fail_earned');}
  // Arm B: the synchronous run with the same refusal for the same person.
  await resetDb();b=await seedBase();await fixture(true);
  await failInserts('test_fail_earned',`new.employment_id='${await employmentNamed(victim)}' and new.leave_type_id='${b.annualLeaveTypeId}' and new.entry_type='accrual'`);
  let syncResult:Awaited<ReturnType<typeof runLeaveGeneration>>,sync:Awaited<ReturnType<typeof snapshot>>;
  try{syncResult=await runLeaveGeneration(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});sync=await snapshot();}
  finally{await dropFailure('test_fail_earned');}
  const strip=(r:unknown)=>{const {runId:_r,...rest}=r as {runId?:string;accrual:{error:string|null}|null};void _r;return {...rest,accrual:rest.accrual?{...rest.accrual,error:Boolean(rest.accrual.error)}:null};};
  expect(syncResult.accrual?.error).toBeTruthy();
  expect((jobResult as typeof syncResult).accrual?.error).toBeTruthy();
  expect(after!.map(strip(jobResult))).toEqual(sync.map(strip(syncResult)));
  expect(after!.state).toEqual(sync.state);
  // The entitlement is written and none of the earned Annual Leave days are.
  expect(syncResult.granted).toBeGreaterThan(EMPLOYEES);
  const earned=(after!.state.ledger as {leave_type_id:string;entry_type:string;effective_on:string}[]).filter(r=>r.leave_type_id==='type:AL'&&r.entry_type==='accrual'&&r.effective_on>'2026-01-01');
  expect(earned).toEqual([]);
  expect(after!.state.events.map(e=>(e as {event_type:string}).event_type)).toEqual(['leave.earned-accrual.run','leave-year.opened','leave-generation.run']);
 },300_000);

 it('a year-open batch refused part-way leaves nothing at all: no ledger row, no event, no log',async()=>{
  await fixture(false);
  const pristine=(await snapshot()).state;
  const job=await createLeaveGenerationJob(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  await tickUntil(job.id,async()=>(await owner.client`select 1 from bulk_job where id=${job.id}::uuid and state='running'`).length>0);
  const [{plan}]=await owner.client<{plan:{generation:{targets:string[]}}}[]>`select plan from bulk_job where id=${job.id}::uuid`;
  const victim=plan.generation.targets[plan.generation.targets.length-1];
  await failInserts('test_fail_open',`new.employment_id='${victim}' and new.leave_type_id='${await typeCode('SICK')}'`);
  try{
   await tickUntil(job.id,async()=>await appliedSteps(job.id,'open')>=3);
   expect(await runJob(job.id)).toBe('failed');
  }finally{await dropFailure('test_fail_open');}
  expect((await readLeaveCohortJob(adminCtx(b),job.id))!.error).toMatch(/refused by a safeguard/);
  expect((await snapshot()).state).toEqual(pristine);
  const [{n}]=await owner.client<{n:number}[]>`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid and stage_id is not null`;
  expect(n).toBe(0);
 },300_000);

 it('an employee another writer changed after their batch was staged is computed again before release (as if the run were atomic then)',async()=>{
  await fixture(false);
  const job=await createLeaveGenerationJob(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  await tickUntil(job.id,async()=>(await owner.client`select 1 from bulk_job where id=${job.id}::uuid and state='finalizing'`).length>0);
  const [{plan}]=await owner.client<{plan:{generation:{targets:string[]}}}[]>`select plan from bulk_job where id=${job.id}::uuid`;
  const changed=await nameOf(plan.generation.targets[1]);
  // Another writer (here a leave debit in the carry window) commits for an employee whose year-open is staged.
  await post(await employmentNamed(changed),b.annualLeaveTypeId,'debit',-3,'2025-10-01');
  expect(await runJob(job.id)).toBe('completed');
  const jobResult=(await readLeaveCohortJob(adminCtx(b),job.id))!.result;
  const [{plan:finished}]=await owner.client<{plan:{releaseAttempts?:number}}[]>`select plan from bulk_job where id=${job.id}::uuid`;
  expect(finished.releaseAttempts).toBe(1);
  const after=await snapshot();
  await resetDb();b=await seedBase();await fixture(false);
  await post(await employmentNamed(changed),b.annualLeaveTypeId,'debit',-3,'2025-10-01');
  const syncResult=await runLeaveGeneration(adminCtx(b),{year:2026,targetMode:'criteria',criteria:{}});
  const sync=await snapshot();
  const strip=(r:unknown)=>{const {runId:_r,...rest}=r as {runId?:string};void _r;return rest;};
  expect(after.map(strip(jobResult))).toEqual(sync.map(strip(syncResult)));
  expect(after.state).toEqual(sync.state);
 },300_000);
});

describe('per-step leave runs: a refusal part-way, then the same run again, ends where an uninterrupted run ends',()=>{
 const balancesAndLedger=async()=>{const {state}=await snapshot();return {ledger:state.ledger,balances:state.balances};};
 const victimWhere=async(extra:string)=>`new.employment_id='${await employmentNamed('Equiv 30')}' and new.leave_type_id='${b.annualLeaveTypeId}' and ${extra}`;
 it('Run Earned Accrual job: the refused batch is left unchanged and reported; running it again completes it',async()=>{
  await fixture(true);
  await accrueEarnedLeave(adminCtx(b),{asOf:'2026-12-31',leaveTypeIds:[b.annualLeaveTypeId]});
  const uninterrupted=await balancesAndLedger();
  await resetDb();b=await seedBase();await fixture(true);
  await failInserts('test_fail_accrual',await victimWhere(`new.entry_type='accrual'`));
  try{
   const first=await createEarnedAccrualJob(adminCtx(b),{asOf:'2026-12-31',leaveTypeIds:[b.annualLeaveTypeId]});
   expect(await runJob(first.id)).toBe('completed');
   const done=await readLeaveCohortJob(adminCtx(b),first.id);
   expect(done!.failedEmployees).toBeGreaterThan(0);
   expect(await balancesAndLedger()).not.toEqual(uninterrupted);
  }finally{await dropFailure('test_fail_accrual');}
  const again=await createEarnedAccrualJob(adminCtx(b),{asOf:'2026-12-31',leaveTypeIds:[b.annualLeaveTypeId]});
  expect(await runJob(again.id)).toBe('completed');
  expect((await readLeaveCohortJob(adminCtx(b),again.id))!.failedEmployees).toBe(0);
  expect(await balancesAndLedger()).toEqual(uninterrupted);
 },300_000);

 it('the monthly accrual and carry-expiry timers: the refused batch is reported after the others, and the next run completes it',async()=>{
  // The reference: the two whole-tenant runs, uninterrupted, in the order the timers run them below.
  await fixture(true);
  await accrueEarnedLeave(systemCtx(),{asOf:'2026-06-30'});
  await expireCarriedLeave(systemCtx(),{today:'2026-04-01'});
  const uninterrupted=await balancesAndLedger();
  // One employee each run actually wrote for: a carry-forward expiry, and an earned top-up.
  const writtenFor=async(where:string)=>(await owner.client.unsafe<{name:string}[]>(`select p.full_name as name from leave_ledger l join employment e on e.id=l.employment_id join person p on p.id=e.person_id
   where l.tenant_id='${b.tenantId}' and ${where} order by p.full_name limit 1`))[0].name;
  const expired=await writtenFor(`l.reason='${CARRY_EXPIRY}'`);
  const topped=await writtenFor(`l.entry_type='accrual' and l.effective_on='2026-06-30'`);
  await resetDb();b=await seedBase();await fixture(true);
  // Each timer: refused for one employee (reported after the others are written), then run again.
  await failInserts('test_fail_accrual_timer',`new.employment_id='${await employmentNamed(topped)}' and new.entry_type='accrual'`);
  try{await expect(accrueEarnedLeaveInBatches(systemCtx(),{asOf:'2026-06-30'},{batchSize:6,maxRetries:0})).rejects.toThrow(/could not be processed/);}
  finally{await dropFailure('test_fail_accrual_timer');}
  await accrueEarnedLeaveInBatches(systemCtx(),{asOf:'2026-06-30'},{batchSize:6});
  await failInserts('test_fail_expiry',`new.employment_id='${await employmentNamed(expired)}' and new.reason='${CARRY_EXPIRY}'`);
  try{await expect(expireCarriedLeaveInBatches(systemCtx(),{today:'2026-04-01'},{batchSize:6,maxRetries:0})).rejects.toThrow(/could not be processed/);}
  finally{await dropFailure('test_fail_expiry');}
  await expireCarriedLeaveInBatches(systemCtx(),{today:'2026-04-01'},{batchSize:6});
  expect(await balancesAndLedger()).toEqual(uninterrupted);
 },300_000);
});
