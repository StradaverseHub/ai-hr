/**
 * Replacement-holiday queue rows of voided employments (migration 7250), 25 November 2026.
 *
 * Staging, 24 November: an employee import created about 2,000 employments and was reverted. The revert voided them,
 * but app.enqueue_replacement_holidays() re-queued each one on its own void UPDATE (and would re-queue every voided
 * employment of the tenant on any holiday, shift or company change). The minute sweep claims them as an HR
 * administrator, employment_rls hides a voided employment, so reconcileReplacementHolidaysTx threw "Employee
 * unavailable." for every row, every 15 minutes, and the provision runner exited 1 every minute.
 *
 * This file proves, with real PostgreSQL and real row security:
 *  - both employee import Revert paths (the background job and the synchronous app.employment_void) leave no queue row
 *    for the employments they void, and a later tenant-wide change queues none of them again;
 *  - the sweep drops a left-over row of a voided employment without counting a failure, and still fails loudly on a
 *    live employment it cannot see (reconcile made to throw the staging error for a live employment);
 *  - at the shape of a real group (70 companies, 1,000 employments, every eighth voided through the owner path), a
 *    tenant-wide change queues exactly the live employments, and the 7250 clean-up statement removes exactly the
 *    voided employments' rows and leaves every live row as it was.
 * Fictional fixtures only. Expected sets are derived from the fixture constants, never from the code under test.
 */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {and,eq,inArray} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {commitEmployeeImport} from '../core/import';
import {previewImportRevert,revertImport} from '../core/import-history';
import {employeeFullRevertHandler} from '../core/employee-import-history';
import {previewImportRevertForAttempt} from '../core/import-history-handlers';
import {revertImportToOutcome} from './helpers/employee-import-revert';
import {sweepReplacementHolidayQueue} from '../scripts/replacement-holiday-sweep';
import {addHolidayDays} from '../lib/holiday-replacement';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';

/** Employments the sweep is made unable to see while they stay live: reconcile throws exactly what row security
 * produced on staging. Every other employment reconciles through the real owner. */
const unseen=vi.hoisted(()=>new Set<string>());
vi.mock('../core/holiday-replacements',async importOriginal=>{
 const actual=await importOriginal<typeof import('../core/holiday-replacements')>();
 return {...actual,reconcileReplacementHolidaysTx:async(...args:Parameters<typeof actual.reconcileReplacementHolidaysTx>)=>{
  if(unseen.has(args[2]))throw new Error('Employee unavailable.');
  return actual.reconcileReplacementHolidaysTx(...args);
 }};
});

beforeAll(migrateTestDb);
afterAll(closeAll);

const day=(n:number)=>addHolidayDays(todayInKualaLumpur(),n);
const queued=async(tenantId:string)=>new Set((await owner.client<{id:string}[]>`select employment_id::text id from replacement_holiday_queue where tenant_id=${tenantId}::uuid`).map(r=>r.id));
const liveEmployments=async(tenantId:string)=>new Set((await owner.client<{id:string}[]>`select id::text id from employment where tenant_id=${tenantId}::uuid and voided_at is null and import_pending_attempt_id is null`).map(r=>r.id));
/** A tenant-wide input change: an original holiday for the base company (no employment_id, so every employment). */
const addHoliday=(b:Base,offset:number)=>owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',companyId:b.companyId,holidayDate:day(offset),name:`Fictional holiday ${offset}`});
const ic=(n:number)=>`88${String(n).padStart(2,'0')}0101${String(n).padStart(4,'0')}`.slice(0,12);
async function hire(b:Base,fullName:string){
 const e=await hireEmployee(adminCtx(b),{person:{fullName,primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-366)});
 return e.employmentId;
}
async function importHires(b:Base,count:number){
 const ctx=adminCtx(b);
 const records=Array.from({length:count},(_,i)=>({full_name:`Fictional Queue Void ${i}`,email:`queue-void-${i}-${b.tenantId.slice(0,8)}@fixture.test`,department:'Finance',
  hired_on:'2026-02-02',ic_number:ic(i+20),basic_salary:'4800',employee_code:`QV${String(i).padStart(3,'0')}`}));
 const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records,fileName:'hires.csv',source:{name:'hires.csv',content:Buffer.from(JSON.stringify(records))}});
 expect(result.imported).toBe(count);
 const ids=(await owner.client<{id:string}[]>`select id::text id from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'QV%' order by employee_code`).map(r=>r.id);
 expect(ids).toHaveLength(count);
 return {ctx,attemptId:result.attemptId!,ids};
}

describe('voiding an employment removes its replacement-holiday queue row',()=>{
 let b:Base;
 beforeEach(async()=>{await resetDb();b=await seedBase();});

 it.each(['background job','synchronous'] as const)('employee import Revert (%s): no queue row survives the void, and none comes back',async mode=>{
  const live1=await hire(b,'Fictional live employee');
  const {ctx,attemptId,ids}=await importHires(b,3);
  // The import queued every new employment (the staging precondition).
  const before=await queued(b.tenantId);
  for(const id of ids)expect(before.has(id)).toBe(true);
  if(mode==='background job'){
   const preview=await previewImportRevertForAttempt(ctx,attemptId);
   expect(await revertImportToOutcome(ctx,attemptId,{previewHash:preview.previewHash,reason:'Wrong company in this file'})).toEqual({attemptId,restored:3});
  }else{
   const preview=await previewImportRevert(ctx,attemptId,employeeFullRevertHandler);
   expect(await revertImport(ctx,attemptId,employeeFullRevertHandler,{previewHash:preview.previewHash,reason:'Wrong company in this file'})).toEqual({attemptId,restored:3});
  }
  const voided=await owner.client<{n:number}[]>`select count(*)::int n from employment where id=any(${ids}::uuid[]) and voided_at is not null`;
  expect(voided[0].n).toBe(3);
  const afterRevert=await queued(b.tenantId);
  for(const id of ids)expect(afterRevert.has(id)).toBe(false);
  // A tenant-wide change re-queues every live employment and none of the voided ones.
  await addHoliday(b,5);
  const live=await liveEmployments(b.tenantId);
  expect(live.has(live1)).toBe(true);
  expect(await queued(b.tenantId)).toEqual(live);
  for(const id of ids)expect(live.has(id)).toBe(false);
  expect(await sweepReplacementHolidayQueue(owner)).toMatchObject({failed:0,dropped:0});
 });

 it('the sweep drops a left-over row of a voided employment without counting a failure',async()=>{
  const {ctx,attemptId,ids}=await importHires(b,2);
  const preview=await previewImportRevert(ctx,attemptId,employeeFullRevertHandler);
  await revertImport(ctx,attemptId,employeeFullRevertHandler,{previewHash:preview.previewHash,reason:'Wrong company in this file'});
  // The state the 5010 body left on staging: a due, previously failed row for each voided employment.
  await owner.client`delete from replacement_holiday_queue where tenant_id=${b.tenantId}::uuid`;
  await owner.client`insert into replacement_holiday_queue(tenant_id,employment_id,requested_at,last_error)
   select ${b.tenantId}::uuid,id,now()-interval '1 minute','Employee unavailable.' from unnest(${ids}::uuid[]) id`;
  expect(await sweepReplacementHolidayQueue(owner)).toMatchObject({processed:0,failed:0,dropped:2});
  expect(await queued(b.tenantId)).toEqual(new Set());
  const [run]=await owner.client<{result:Record<string,number>}[]>`select result from job_run where job_key='replacement-holidays.reconcile' order by ran_at desc limit 1`;
  expect(run.result).toMatchObject({failed:0,dropped:2});
 });

 it('a live employment the sweep cannot see still fails loudly and keeps its row',async()=>{
  const id=await hire(b,'Fictional unseen employee');
  unseen.add(id);
  try{
   await owner.client`update replacement_holiday_queue set requested_at=now()-interval '1 minute' where tenant_id=${b.tenantId}::uuid and employment_id=${id}::uuid`;
   expect(await sweepReplacementHolidayQueue(owner)).toMatchObject({processed:0,failed:1,dropped:0});
  }finally{unseen.delete(id);}
  const [row]=await owner.db.select().from(schema.replacementHolidayQueue).where(and(eq(schema.replacementHolidayQueue.tenantId,b.tenantId),eq(schema.replacementHolidayQueue.employmentId,id)));
  expect(row).toMatchObject({lastError:'Employee unavailable.',claimedAt:null});
  expect(row.requestedAt.getTime()).toBeGreaterThan(Date.now()+10*60_000);
 });
});

describe('at the shape of a real group: 70 companies, 1,000 employments',()=>{
 const COMPANIES=70,N=1000,isVoided=(n:number)=>n%8===0,VOIDED=Math.floor(N/8);
 it('a tenant-wide change queues exactly the live employments, and the 7250 clean-up removes exactly the voided rows',async()=>{
  await resetDb();const b=await seedBase(),T=b.tenantId;
  const baseLive=await liveEmployments(T);
  const fixture=new Map<number,string>();
  await owner.client.begin(async tx=>{
   await tx`set local session_replication_role = replica`;
   const others=await tx<{id:string}[]>`insert into company(tenant_id,legal_name) select ${T}::uuid,'Queue shape company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer) n order by n returning id`;
   const companies=[b.companyId,...others.map(r=>r.id)];
   await tx`with people as(insert into person(tenant_id,full_name,primary_email) select ${T}::uuid,'Queue shape person '||lpad(n::text,4,'0'),'queue-shape-'||n||'@fixture.invalid' from generate_series(1,${N}::integer) n returning id,full_name)
    insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${T}::uuid,id,(${companies}::uuid[])[1+((right(full_name,4)::int-1)%${COMPANIES}::integer)],'QS-'||right(full_name,4),'2025-01-01'::date from people`;
   for(const r of await tx<{id:string;code:string}[]>`select id::text id,employee_code code from employment where tenant_id=${T}::uuid and employee_code like 'QS-%'`)fixture.set(Number(r.code.slice(3)),r.id);
  });
  expect(fixture.size).toBe(N);
  const voidedIds=[...fixture].filter(([n])=>isVoided(n)).map(([,id])=>id),liveIds=[...fixture].filter(([n])=>!isVoided(n)).map(([,id])=>id);
  expect(voidedIds).toHaveLength(VOIDED);
  // Queue every fixture employment, then void every eighth through the owner path (any writer of voided_at).
  await addHoliday(b,5);
  expect((await queued(T)).size).toBe(baseLive.size+N);
  const [attempt]=await owner.client<{id:string}[]>`insert into import_attempt(tenant_id,kind,created_by,company_ids,mime_type,operation_key,plan,source_content,source_hash,source_name)
   values(${T}::uuid,'employee_full',${b.adminUserId}::uuid,${`{${b.companyId}}`}::uuid[],'text/csv',${randomUUID()}::uuid,'{}'::jsonb,'\\x'::bytea,encode(sha256('\\x'::bytea),'hex'),'fixture.csv') returning id`;
  await owner.client`update employment set voided_at=now(),voided_by=${b.adminUserId}::uuid,void_reason='Fictional void',voided_import_attempt_id=${attempt.id}::uuid,voided_employee_code=employee_code,employee_code=null where id=any(${voidedIds}::uuid[])`;
  const afterVoid=await queued(T);
  expect(afterVoid.size).toBe(baseLive.size+N-VOIDED);
  for(const id of voidedIds)expect(afterVoid.has(id)).toBe(false);
  // A second tenant-wide change: exactly the live employments, none of the voided ones.
  await addHoliday(b,6);
  expect(await queued(T)).toEqual(new Set([...baseLive,...liveIds]));

  // The rows the 5010 body left behind (staging's state), written directly, then the 7250 clean-up statement.
  await owner.client`insert into replacement_holiday_queue(tenant_id,employment_id,requested_at,last_error)
   select ${T}::uuid,id,now()-interval '1 minute','Employee unavailable.' from unnest(${voidedIds}::uuid[]) id`;
  const liveRows=()=>owner.db.select({employmentId:schema.replacementHolidayQueue.employmentId,generation:schema.replacementHolidayQueue.generation,requestedAt:schema.replacementHolidayQueue.requestedAt,lastError:schema.replacementHolidayQueue.lastError})
   .from(schema.replacementHolidayQueue).where(and(eq(schema.replacementHolidayQueue.tenantId,T),inArray(schema.replacementHolidayQueue.employmentId,liveIds))).orderBy(schema.replacementHolidayQueue.employmentId);
  const liveBefore=await liveRows();
  expect(liveBefore).toHaveLength(N-VOIDED);
  expect((await queued(T)).size).toBe(baseLive.size+N);
  const chunks=readFileSync('db/migrations/7250_replacement_holiday_queue_voided.sql','utf8').split('--> statement-breakpoint');
  const cleanup=chunks[chunks.length-1].split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').trim();
  expect(cleanup).toMatch(/^DELETE FROM replacement_holiday_queue q USING employment e WHERE/);
  await owner.client.unsafe(cleanup);
  expect(await queued(T)).toEqual(new Set([...baseLive,...liveIds]));
  expect(await liveRows()).toEqual(liveBefore);
 });
});
