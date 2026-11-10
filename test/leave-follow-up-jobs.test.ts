/**
 * The leave follow-up work a configuration save starts, on the shared bulk-job kernel (core/leave-follow-up-worker.ts):
 * the entitlement recalculation after a table save (one employee per step, as the per-employee transactions were)
 * and the A2C re-projection after a Leave Year Type save (staged, released at once, as the save's one transaction
 * was). Each arm runs in a fresh database built by the same fixture; ids are mapped to employee names and codes.
 * Also the kernel extension these need: a kind with exclusive 'none' admits several active jobs per person.
 */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {openLeaveYear,reprojectEntitlementForLeaveTypeCohort} from '../core/leave';
import {updateLeaveType} from '../core/admin';
import {updateEntitlementTemplate} from '../core/entitlement-template';
import {createLeaveRecalcJob,readLeaveCohortJob} from '../core/leave-cohort-job';
import {leaveA2cJobHandler,leaveRecalcJobHandler} from '../core/leave-follow-up-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);

const ASOF='2026-06-15';
const HIRED=['2019-03-04','2023-01-02','2025-05-20','2026-01-05','2026-02-10','2026-03-01','2026-04-20'];
async function people(n:number){
 const out:string[]=[];
 for(let i=0;i<n;i++){
  const {employmentId}=await hireEmployee(adminCtx(b),{person:{fullName:`Follow ${String(i).padStart(2,'0')}`,primaryEmail:`fu_${randomUUID().slice(0,8)}@t.local`},
   companyId:b.companyId,departmentId:i%2?b.deptA:b.deptB,employmentType:'full_time',hiredOn:HIRED[i%HIRED.length]});
  out.push(employmentId);
 }
 return out;
}
async function snapshot(){
 const names=new Map<string,string>();
 for(const r of await owner.client<{id:string;name:string}[]>`select e.id,p.full_name as name from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid`)names.set(r.id,r.name);
 for(const r of await owner.client<{id:string;code:string}[]>`select id,code from leave_type where tenant_id=${b.tenantId}::uuid`)names.set(r.id,'type:'+r.code);
 names.set(b.tenantId,'TENANT');names.set(b.companyId,'COMPANY');names.set(b.adminUserId,'ADMIN');
 const ledgerIds=new Map<string,string>();
 const ledger=[...await owner.client<{id:string}[]>`select l.id,l.employment_id,l.leave_type_id,l.entry_type,l.days::text,l.effective_on::text,l.reason,l.stage_id from leave_ledger l where l.tenant_id=${b.tenantId}::uuid order by l.employment_id,l.leave_type_id,l.entry_type,l.days,l.effective_on,l.reason`];
 // A ledger row is named by its content, so an event or history row pointing at it compares across databases.
 for(const r of ledger){const {id,...rest}=r as Record<string,unknown>;ledgerIds.set(id as string,JSON.stringify(rest).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,m=>names.get(m)??m));}
 const map=(v:unknown):unknown=>{
  if(typeof v==='string')return names.get(v)??ledgerIds.get(v)??v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,m=>names.get(m)??m);
  if(Array.isArray(v))return v.map(map).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([x],[y])=>x.localeCompare(y)).map(([k,x])=>[k,map(x)]));
  return v;
 };
 const audit=await owner.client`select employment_id,leave_type_id,previous_entitlement::text,new_entitlement::text,delta::text,reason,effective_on::text,change_effective_on::text,previous_grade_id,new_grade_id,ledger_id from leave_entitlement_recalc_audit where tenant_id=${b.tenantId}::uuid`;
 const events=await owner.client`select event_type,aggregate_type,aggregate_id,actor_type,actor_id,subject_employment_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type in ('leave.entitlement.recalculated','leave-type.updated')`;
 return {ledger:map(ledger.map(({id:_i,...r})=>r)),audit:map([...audit]),events:map([...events].map(e=>({...e}))),map};
}
const handlers=[leaveRecalcJobHandler,leaveA2cJobHandler];
async function drain(){
 for(let i=0;i<5000;i++){
  const [row]=await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job where tenant_id=${b.tenantId}::uuid and (state in ('queued','preparing','running','finalizing','discarding') or notified_at is null)`;
  if(!row.n)return;
  if(!await runBulkJobTick(owner.client,{handlers}))await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error('jobs did not finish');
}

describe('entitlement recalculation after a save runs on the kernel and leaves exactly what the save-time loop left',()=>{
 async function fixture(){
  const tpl=await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:12,validFrom:'2026-01-01',name:'fixture AL'});
  await people(18);
  await openLeaveYear(adminCtx(b),{year:2026});
  await updateEntitlementTemplate(adminCtx(b),{lineageId:tpl.lineageId,serviceBands:[{fromYears:0,toYears:3,days:14},{fromYears:3,toYears:null,days:17}],validFrom:'2026-02-01'});
 }
 it('same ledger, history rows, events and result; one employee per step',async()=>{
  await fixture();
  const sync=await reprojectEntitlementForLeaveTypeCohort(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,trigger:'entitlement_template_updated',asOf:ASOF});
  const before=await snapshot();
  await resetDb();b=await seedBase();await fixture();
  const job=await createLeaveRecalcJob(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,trigger:'entitlement_template_updated',asOf:ASOF});
  expect(job.kind).toBe('leave_recalc');
  await drain();
  const done=await readLeaveCohortJob(adminCtx(b),job.id);
  const after=await snapshot();
  expect(sync.affected).toBeGreaterThan(5);
  expect(done).toMatchObject({state:'completed',failedEmployees:0,result:{employees:sync.employees,affected:sync.affected,totalDelta:sync.totalDelta}});
  expect(after.ledger).toEqual(before.ledger);
  expect(after.audit).toEqual(before.audit);
  expect(after.events).toEqual(before.events);
  const [{steps}]=await owner.client<{steps:number}[]>`select steps_total as steps from bulk_job where id=${job.id}::uuid`;
  expect(steps).toBe(sync.employees);
 },300_000);

 it('the kernel admits a second active recalculation for the same person (exclusive none); a tenant kind still refuses',async()=>{
  await fixture();
  const one=await createLeaveRecalcJob(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,trigger:'a',asOf:ASOF});
  const two=await createLeaveRecalcJob(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,trigger:'b',asOf:ASOF});
  expect(two.id).not.toBe(one.id);
  const keys=await owner.client<{exclusive_key:string}[]>`select exclusive_key from bulk_job where id in (${one.id}::uuid,${two.id}::uuid)`;
  expect(new Set(keys.map(k=>k.exclusive_key)).size).toBe(2);
  expect(keys.every(k=>k.exclusive_key.startsWith('job:'))).toBe(true);
  // Unchanged rules for the existing kinds: 'tenant' and 'creator' keys are still derived by the database.
  const [kinds]=await owner.client<{tenant:string;creator:string}[]>`select (select exclusive from bulk_job_kind where kind='leave_generation') as tenant,(select exclusive from bulk_job_kind where kind='leave_ledger') as creator`;
  expect(kinds).toEqual({tenant:'tenant',creator:'creator'});
  await drain();
  // The two jobs interleave (the worker is fair across jobs); they converge: every employee is corrected once, by
  // whichever job reached them first, and a further recalculation finds nothing left.
  const r1=(await readLeaveCohortJob(adminCtx(b),one.id))!.result as {affected:number};
  const r2=(await readLeaveCohortJob(adminCtx(b),two.id))!.result as {affected:number};
  expect(r1.affected+r2.affected).toBeGreaterThan(5);
  const twice=await owner.client<{n:number}[]>`select count(*)::int as n from (select employment_id,leave_type_id from leave_entitlement_recalc_audit where tenant_id=${b.tenantId}::uuid group by 1,2 having count(*)>1) x`;
  expect(twice[0].n).toBe(0);
  expect((await reprojectEntitlementForLeaveTypeCohort(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,trigger:'c',asOf:ASOF})).affected).toBe(0);
 },300_000);
});

describe('the A2C re-projection after a Leave Year Type save is staged and released at once',()=>{
 async function fixture(){
  await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:12,validFrom:'2026-01-01',name:'fixture AL'});
  await people(21);
  await openLeaveYear(adminCtx(b),{year:2026});
 }
 const save=(background:boolean)=>updateLeaveType(adminCtx(b),{id:b.annualLeaveTypeId,name:'Annual Leave',yearCycleOverride:'a2c',asOf:ASOF,a2cInBackground:background});
 it('same ledger rows, history rows and events as the save-time correction; nothing visible before release',async()=>{
  await fixture();
  await save(false);
  const sync=await snapshot();
  await resetDb();b=await seedBase();await fixture();
  const [{n:rowsBefore}]=await owner.client<{n:number}[]>`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid`;
  await save(true);
  const [{id}]=await owner.client<{id:string}[]>`select id from bulk_job where tenant_id=${b.tenantId}::uuid and kind='leave_a2c'`;
  // Run every batch but stop before the release: the corrections are staged and nobody sees them.
  for(let i=0;i<2000;i++){
   const [row]=await owner.client<{state:string}[]>`select state from bulk_job where id=${id}::uuid`;
   if(row.state==='finalizing')break;
   if(!await runBulkJobTick(owner.client,{handlers}))await new Promise(resolve=>setTimeout(resolve,20));
  }
  const [{staged,visible}]=await owner.client<{staged:number;visible:number}[]>`select count(*) filter (where stage_id is not null)::int as staged,count(*) filter (where stage_id is null)::int as visible from leave_ledger where tenant_id=${b.tenantId}::uuid`;
  expect(staged).toBeGreaterThan(0);
  expect(visible).toBe(rowsBefore);
  const [{h}]=await owner.client<{h:number}[]>`select count(*)::int as h from leave_entitlement_recalc_audit where tenant_id=${b.tenantId}::uuid`;
  expect(h).toBe(0);
  await drain();
  const job=await readLeaveCohortJob(adminCtx(b),id);
  expect(job).toMatchObject({kind:'leave_a2c',state:'completed'});
  const after=await snapshot();
  expect((after.audit as unknown[]).length).toBeGreaterThan(2);
  expect(after.ledger).toEqual(sync.ledger);
  expect(after.audit).toEqual(sync.audit);
  // The same events; the save's own leave-type.updated now commits before the job's corrections.
  expect(after.events).toEqual(sync.events);
 },300_000);

 it('a batch refused part-way leaves no correction at all, as the save transaction did',async()=>{
  await fixture();
  const victims=(await owner.client<{id:string}[]>`select id from employment where tenant_id=${b.tenantId}::uuid and hired_on>='2026-01-01' order by id desc limit 1`).map(r=>r.id);
  await owner.client.unsafe(`create or replace function public.test_fail_a2c() returns trigger language plpgsql as $$ begin if new.employment_id='${victims[0]}' and new.reason like 'sys:a2c%' then raise exception 'injected failure for this test'; end if; return new; end $$`);
  await owner.client.unsafe(`create trigger test_fail_a2c before insert on leave_ledger for each row execute function public.test_fail_a2c()`);
  try{
   const [{n:before}]=await owner.client<{n:number}[]>`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid`;
   await save(true);
   await drain();
   const [{id}]=await owner.client<{id:string}[]>`select id from bulk_job where tenant_id=${b.tenantId}::uuid and kind='leave_a2c'`;
   expect(await readLeaveCohortJob(adminCtx(b),id)).toMatchObject({state:'failed'});
   const [{n:after}]=await owner.client<{n:number}[]>`select count(*)::int as n from leave_ledger where tenant_id=${b.tenantId}::uuid`;
   expect(after).toBe(before);
   const [{h}]=await owner.client<{h:number}[]>`select count(*)::int as h from leave_entitlement_recalc_audit where tenant_id=${b.tenantId}::uuid`;
   expect(h).toBe(0);
   const [{e}]=await owner.client<{e:number}[]>`select count(*)::int as e from domain_event where tenant_id=${b.tenantId}::uuid and event_type='leave.entitlement.recalculated'`;
   expect(e).toBe(0);
  }finally{await owner.client.unsafe(`drop trigger if exists test_fail_a2c on leave_ledger; drop function if exists public.test_fail_a2c()`);}
  void eq;void schema;
 },300_000);
});
