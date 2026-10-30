/** 0754 compatibility: Native draft deletion must remain available after Assistant reset/reopen custody.
 * Fictional real encrypted reviews; desired native outcome, no accepted FK failure.
 * Uses real encrypted custody and native effects; owner-only concurrency setup is labelled. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {withTenant,type Tx,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assignRole} from '../core/admin';
import {erasePersonPii} from '../core/pdpa';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {grantAssistant} from '../core/assistant-grant';
import {createBatch,generatePayslips,closeBatch,unlockClosedBatch,resetProcessedBatch,deleteDraftBatch,createAdditionalRun,setPayrollInput} from '../packs/payroll/service';
import {preparePayrollResetReview,confirmPayrollResetReview,discardPayrollResetReview,reopenPayrollResetReview,listPayrollResetReviews} from '../core/assistant-actions/payroll-reset-review-store';
import {preparePayrollReopenReview,confirmPayrollReopenReview} from '../core/assistant-actions/payroll-reopen-review-store';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,batchId:string,periodId:string,period:string,employmentId:string;
const reason='Fictional native lifecycle correction';
const resetHuman=()=>({action:'payroll.reset' as const,contractVersion:1 as const,batchId,reason,confirmResetProcessedRun:true,acknowledgePayslipLoanClaimConsequences:true});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-payroll-lifecycle-key-123456');await resetDb();b=await seedBase();
 for(const code of ['assistant','payroll','multi_cycle_payroll'] as const)await setModule(b.tenantId,code,'active');
 ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});
 const year=Number(todayInKualaLumpur().slice(0,4));period=String(year-1)+'-08';
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional lifecycle employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(year-2)+'-01-01'});
 employmentId=hired.employmentId;
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:5000,effectiveFrom:String(year-2)+'-01-01'});
 await requirePackFor('MY').statutory.set(ctx,{personId:hired.personId,icNumber:'900101019885'});
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await generatePayslips(ctx,{batchId});
 await setSetting(b.tenantId,'payroll.reset_enabled',true);await setSetting(b.tenantId,'payroll.unlock_enabled',true);
 ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 const [batch]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));periodId=batch.payPeriodId;
});
async function prepareReset(){const r=await preparePayrollResetReview(ctx,resetHuman());if(r.kind!=='prepared')throw Error('Expected real encrypted reset review');return r.review;}
async function deletionState(){return{
 batch:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)),
 parent:await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.id,periodId)),
 slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId)).orderBy(s.payslip.id),
 history:await owner.db.select().from(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId)).orderBy(s.payrollStatusHistory.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
 reviews:await owner.db.execute(sql`select to_jsonb(r) as row from app.assistant_own_leave_review r where tenant_id=${b.tenantId}::uuid order by id`),
 bodies:await owner.db.execute(sql`select to_jsonb(c) as row from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${b.tenantId}::uuid order by c.action_id`),
};}
const errorCode=(error:unknown)=>{if(!error||typeof error!=='object')return undefined;const e=error as {code?:string;cause?:{code?:string}};return e.cause?.code??e.code;};
async function completed(){const r=await prepareReset();const done=await confirmPayrollResetReview(ctx,{action:'payroll.reset',contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});if(done.kind!=='completed')throw Error('Expected genuine completed reset');return{r,receipt:done.receipt.receipt};}
async function ledger(id:string){return Array.from(await owner.db.execute(sql`select to_jsonb(r) as row from app.assistant_own_leave_review r where id=${id}::uuid`));}
async function capture(id:string){return{
 rows:Array.from(await owner.db.execute(sql`select to_jsonb(c) as row from app.native_outcome_source_capture c where review_id=${id}::uuid order by id`)),
 targets:Array.from(await owner.db.execute(sql`select to_jsonb(t) as row from app.native_outcome_source_target t join app.native_outcome_source_capture c on c.id=t.capture_id where c.review_id=${id}::uuid order by t.kind,t.target_id`)),
 associations:Array.from(await owner.db.execute(sql`select to_jsonb(a) as row from public.ai_native_outcome_association a where review_id=${id}::uuid order by id`)),
};}
async function pendingStatus(id:string){const [r]=await owner.db.execute<{state:string;proof:unknown;people:unknown;intent:unknown;digest:unknown;body:number}>(sql`select state,payroll_reset_proof proof,payroll_reset_person_ids people,intent_digest intent,reviewed_digest digest,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) body from app.assistant_own_leave_review r where id=${id}::uuid`);return r;}
async function secondActor(){const userId=await createAppUser(b.tenantId,null,'employee');await assignRole(ctx,{appUserId:userId,role:'hr_admin',companyId:null});await grantAssistant(ctx,{appUserId:userId});return{...await entitledCtx(b,['employee','hr_admin']),userId,personId:undefined,grants:[{role:'employee' as const,companyId:null},{role:'hr_admin' as const,companyId:null}]};}
async function pendingFor(actor:SessionContext,id=batchId){const result=await preparePayrollResetReview(actor,{...resetHuman(),batchId:id});if(result.kind!=='prepared')throw Error('Expected genuine pending review');return result.review;}
async function rawDelete(){return withTenant(ctx,async tx=>{
 // Deliberate ordinary RLS SQL writer, not a duplicate production teardown owner.
 await tx.delete(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId));
 await tx.delete(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));
});}
async function waitingOn(holder:number){for(let n=0;n<500;n++){const [row]=await owner.db.execute<{pid:number;wait:string}>(sql`select a.pid,a.wait_event_type as wait from pg_stat_activity a where ${holder}=any(pg_blocking_pids(a.pid)) and a.pid<>pg_backend_pid() order by a.pid limit 1`);if(row){expect(row.wait).toBe('Lock');return row.pid;}await new Promise<void>(yes=>setTimeout(yes,10));}throw Error('Actual PostgreSQL blocking edge was not observed');}
async function capturedPending(){const r=await prepareReset();const [saved]=await owner.db.execute<{row:Record<string,unknown>;body:Record<string,unknown>}>(sql`select to_jsonb(r) as row,to_jsonb(c) as body from app.assistant_own_leave_review r join app.assistant_own_leave_review_content c on c.action_id=r.id where r.id=${r.actionId}::uuid`);expect(saved.body).not.toBeNull();await owner.db.execute(sql`delete from app.assistant_own_leave_review where id=${r.actionId}::uuid`);await resetProcessedBatch(ctx,{batchId,reason});return{r,...saved};}
async function restoreCaptured(tx:Tx,saved:Awaited<ReturnType<typeof capturedPending>>){
 // OWNER-ONLY fixture restoring the whole genuinely encrypted row to isolate database guard
 // liveness. No claim this is a caller capability or an authorized fresh prepare on a draft.
 await tx.execute(sql`insert into app.assistant_own_leave_review select (jsonb_populate_record(NULL::app.assistant_own_leave_review,${JSON.stringify(saved.row)}::jsonb)).*`);
 await tx.execute(sql`insert into app.assistant_own_leave_review_content select (jsonb_populate_record(NULL::app.assistant_own_leave_review_content,${JSON.stringify(saved.body)}::jsonb)).*`);
}
describe('Payroll review/native draft deletion compatibility',()=>{
 it('atomically retires both actual target users while retaining a sibling review byte-for-byte',async()=>{
  const actor=await secondActor(),first=await prepareReset(),second=await pendingFor(actor);
  const sibling=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'})).batchId;await setPayrollInput(ctx,{batchId:sibling,employmentId,overtimeAmount:0,bonusAmount:100});await generatePayslips(ctx,{batchId:sibling});
  const other=await pendingFor(actor,sibling),beforeOther=await ledger(other.actionId);await resetProcessedBatch(ctx,{batchId,reason});await deleteDraftBatch(ctx,{batchId});
  for(const r of [first,second])expect(await pendingStatus(r.actionId)).toEqual({state:'refused',proof:null,people:null,intent:null,digest:null,body:0});expect(await ledger(other.actionId)).toEqual(beforeOther);
  expect((await listPayrollResetReviews(ctx)).reviews.map(r=>r.actionId)).toContain(first.actionId);expect((await discardPayrollResetReview(ctx,{action:'payroll.reset',contractVersion:1,actionId:first.actionId})).kind).toBe('retired');
 });
 it('preserves completed identity, original event and nonempty privacy capture after target deletion and recreation',async()=>{
  const {r,receipt}=await completed(),beforeLedger=await ledger(r.actionId),beforeCapture=await capture(r.actionId),originalEvent=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,receipt.resetEventId));expect(beforeCapture.rows.length).toBeGreaterThan(0);expect(beforeCapture.targets.length).toBeGreaterThan(0);
  await deleteDraftBatch(ctx,{batchId});expect(await ledger(r.actionId)).toEqual(beforeLedger);expect(await capture(r.actionId)).toEqual(beforeCapture);expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,receipt.resetEventId))).toEqual(originalEvent);
  await expect(reopenPayrollResetReview(ctx,r.actionId)).rejects.toThrow();const newBatch=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;expect(newBatch).not.toBe(batchId);const before=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,newBatch));
  await expect(confirmPayrollResetReview(ctx,{action:'payroll.reset',contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest})).rejects.toThrow();expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,newBatch))).toEqual(before);expect(await capture(r.actionId)).toEqual(beforeCapture);
 });
 it('retains canonical PDPA discovery after the completed run has been deleted',async()=>{
  const {r}=await completed();expect((await capture(r.actionId)).targets.length).toBeGreaterThan(0);await deleteDraftBatch(ctx,{batchId});await erasePersonPii(ctx,{subjectEmploymentId:employmentId,scope:'contact',requestRef:'FICTIONAL-DELETE-RETAINED-CAPTURE',reason:'Fictional retained provenance erasure'});expect((await capture(r.actionId)).rows).toEqual([]);expect((await capture(r.actionId)).targets).toEqual([]);
 });
 it('leaves all target state unchanged when a foreign ordinary user attempts deletion or private cleanup',async()=>{
  await prepareReset();await resetProcessedBatch(ctx,{batchId,reason});const userId=await createAppUser(b.tenantId,null,'employee'),foreign={...await entitledCtx(b,['employee']),userId,personId:undefined,grants:[{role:'employee' as const,companyId:null}]},before=await deletionState();await expect(deleteDraftBatch(foreign,{batchId})).rejects.toThrow();expect(await deletionState()).toEqual(before);
  for(const name of ['assistant_payroll_review_target_deleted','assistant_payroll_review_historical_binding'])await expect(withTenant(foreign,tx=>tx.execute(sql.raw('select app.'+name+'()')))).rejects.toThrow();expect(await deletionState()).toEqual(before);
  await expect(withTenant(foreign,tx=>tx.execute(sql`insert into app.assistant_own_leave_review(id) values(${randomUUID()}::uuid)`))).rejects.toThrow();expect(await deletionState()).toEqual(before);
 });
 it.each(['ledger','body'] as const)('rolls back the entire native deletion when its exact pending %s row is busy',async(kind)=>{
  const r=await prepareReset();await resetProcessedBatch(ctx,{batchId,reason});const before=await deletionState();let ready!:()=>void,release!:()=>void;const start=new Promise<void>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});const holder=owner.db.transaction(async tx=>{if(kind==='ledger')await tx.execute(sql`select id from app.assistant_own_leave_review where id=${r.actionId}::uuid for update`);else await tx.execute(sql`select action_id from app.assistant_own_leave_review_content where action_id=${r.actionId}::uuid for update`);ready();await finish;});await start;
  try{let failure:unknown;try{await deleteDraftBatch(ctx,{batchId});}catch(e){failure=e;}expect(errorCode(failure)).toBe('55P03');expect(await deletionState()).toEqual(before);}finally{release();await holder;}
  await deleteDraftBatch(ctx,{batchId});expect((await pendingStatus(r.actionId)).state).toBe('refused');
 });
 it('rolls back pending retirement when a later actual delete trigger fails',async()=>{
  const r=await prepareReset();await resetProcessedBatch(ctx,{batchId,reason});const before=await deletionState();await owner.db.execute(sql`create function app.zz_fictional_payroll_delete_failure() returns trigger language plpgsql as $$begin raise exception 'Fictional late deletion failure' using errcode='23514';end$$`);await owner.db.execute(sql`create trigger zz_fictional_payroll_delete_failure after delete on public.payroll_batch for each row execute function app.zz_fictional_payroll_delete_failure()`);
  try{let failure:unknown;try{await deleteDraftBatch(ctx,{batchId});}catch(e){failure=e;}expect(errorCode(failure)).toBe('23514');expect(await deletionState()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger zz_fictional_payroll_delete_failure on public.payroll_batch`);await owner.db.execute(sql`drop function app.zz_fictional_payroll_delete_failure()`);}
  expect((await pendingStatus(r.actionId)).state).toBe('awaiting_confirmation');
 });
 it.each(['native','raw'] as const)('holds inserted soft bindings against a concurrent %s deletion',async(kind)=>{
  const saved=await capturedPending();let ready!:(pid:number)=>void,release!:()=>void;const start=new Promise<number>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});const inserting=owner.db.transaction(async tx=>{await restoreCaptured(tx,saved);const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);ready(row.pid);await finish;});const holderPid=await start;const deletion=kind==='native'?deleteDraftBatch(ctx,{batchId}):rawDelete();void deletion.catch(()=>undefined);
  try{const waiter=await waitingOn(holderPid);expect(waiter).not.toBe(holderPid);expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).length).toBe(1);}finally{release();await inserting;await deletion;}
  expect((await pendingStatus(saved.r.actionId)).state).toBe('refused');expect((await pendingStatus(saved.r.actionId)).body).toBe(0);expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).toEqual([]);
 });
 it('rejects an orphan insertion after an ordinary RLS deletion commits first',async()=>{
  const saved=await capturedPending();let ready!:(pid:number)=>void,release!:()=>void;const start=new Promise<number>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});const deleting=withTenant(ctx,async tx=>{await tx.delete(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId));await tx.delete(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);ready(row.pid);await finish;});const holderPid=await start;const inserting=owner.db.transaction(tx=>restoreCaptured(tx,saved));void inserting.catch(()=>undefined);
  try{await waitingOn(holderPid);}finally{release();await deleting;}
  let failure:unknown;try{await inserting;}catch(e){failure=e;}expect(errorCode(failure)).toBe('23503');expect(await ledger(saved.r.actionId)).toEqual([]);expect((await deletionState()).bodies).toEqual([]);expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).toEqual([]);
 });
 it('keeps historical binding components immutable under real owner updates',async()=>{
  const r=await prepareReset(),before=await ledger(r.actionId);for(const column of ['payroll_reset_batch_id','payroll_reset_period_id']){let failure:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=${randomUUID()}::uuid where id=${r.actionId}::uuid`);}catch(e){failure=e;}expect(errorCode(failure)).toBe('23514');expect(await ledger(r.actionId)).toEqual(before);}
 });
 it('rejects orphan insertion after the genuine native deletion owns its physical row first',async()=>{
  const saved=await capturedPending();await owner.db.execute(sql`create function app.zz_fictional_payroll_delete_barrier() returns trigger language plpgsql as $$begin perform pg_advisory_xact_lock(754,1001);return NULL;end$$`);await owner.db.execute(sql`create trigger zz_fictional_payroll_delete_barrier after delete on public.payroll_batch for each row execute function app.zz_fictional_payroll_delete_barrier()`);
  let ready!:(pid:number)=>void,release!:()=>void;const start=new Promise<number>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});const gate=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(754,1001)`);const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);ready(row.pid);await finish;});const gatePid=await start;
  const deletion=deleteDraftBatch(ctx,{batchId});void deletion.catch(()=>undefined);let inserting:Promise<unknown>|undefined,failure:unknown;
  try{const deletePid=await waitingOn(gatePid);inserting=owner.db.transaction(tx=>restoreCaptured(tx,saved));void inserting.catch(()=>undefined);await waitingOn(deletePid);}
  finally{release();await gate;try{await deletion;if(inserting)try{await inserting;}catch(e){failure=e;}}finally{await owner.db.execute(sql`drop trigger zz_fictional_payroll_delete_barrier on public.payroll_batch`);await owner.db.execute(sql`drop function app.zz_fictional_payroll_delete_barrier()`);}}
  expect(errorCode(failure)).toBe('23503');expect(await ledger(saved.r.actionId)).toEqual([]);expect((await deletionState()).bodies).toEqual([]);expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).toEqual([]);expect(await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.id,periodId))).toEqual([]);
 });
 it('leaves unrelated owner cleanup admitted without a fabricated current native actor',async()=>{
  await resetProcessedBatch(ctx,{batchId,reason});await owner.db.delete(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId));await owner.db.delete(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));await owner.db.delete(s.payPeriod).where(eq(s.payPeriod.id,periodId));expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).toEqual([]);
 });
 it('removes only live-target reference FKs while retaining event references, strict kind checks and private function privileges',async()=>{
  const rows=await owner.db.execute<{name:string;column:string;type:string}>(sql`select c.conname name,a.attname as column,c.contype::text as type from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) where c.conrelid='app.assistant_own_leave_review'::regclass and c.contype='f'`);
  for(const name of ['payroll_reset_batch_id','payroll_reset_period_id','payroll_reopen_batch_id','payroll_reopen_period_id'])expect(rows.some(r=>r.column===name)).toBe(false);
  for(const name of ['payroll_reset_event_id','payroll_reopened_event_id'])expect(rows.filter(r=>r.column===name)).toHaveLength(1);
  const checks=await owner.db.execute<{name:string;valid:boolean}>(sql`select conname name,convalidated as valid from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and conname in('assistant_payroll_reset_columns','assistant_payroll_reopen_columns')`);expect(checks).toHaveLength(2);expect(checks.every(c=>c.valid)).toBe(true);
  const [privileges]=await owner.db.execute<{target:boolean;binding:boolean}>(sql`select has_function_privilege('ai_hr_app','app.assistant_payroll_review_target_deleted()','execute') as target,has_function_privilege('ai_hr_app','app.assistant_payroll_review_historical_binding()','execute') as binding`);expect(privileges).toEqual({target:false,binding:false});
 });

 it('refuses an actual late BEFORE INSERT rewrite to a missing target rather than trusting nominated bindings',async()=>{
  const saved=await capturedPending(),before=await deletionState();await owner.db.execute(sql`create function app.zz_fictional_review_binding_rewrite() returns trigger language plpgsql as $$begin if NEW.action_kind='payroll.reset' then NEW.payroll_reset_batch_id:=gen_random_uuid();end if;return NEW;end$$`);await owner.db.execute(sql`create trigger zz_fictional_review_binding_rewrite before insert on app.assistant_own_leave_review for each row execute function app.zz_fictional_review_binding_rewrite()`);
  try{let failure:unknown;try{await owner.db.transaction(tx=>restoreCaptured(tx,saved));}catch(e){failure=e;}expect(errorCode(failure)).toBe('23503');expect(await deletionState()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger zz_fictional_review_binding_rewrite on app.assistant_own_leave_review`);await owner.db.execute(sql`drop function app.zz_fictional_review_binding_rewrite()`);}
 });

 it('retires a genuine pending reopening through native unlock, reset and deletion while preserving its sibling',async()=>{
  const sibling=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'})).batchId,siblingBefore=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,sibling));
  await closeBatch(ctx,{batchId});const prepared=await preparePayrollReopenReview(ctx,{action:'payroll.reopen',contractVersion:1,batchId,reason,confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true});if(prepared.kind!=='prepared')throw Error('Expected genuine pending reopening review');const id=prepared.review.actionId;
  const identity=async()=>Array.from(await owner.db.execute(sql`select to_jsonb(r)-ARRAY['state','intent_digest','reviewed_digest','payroll_reopen_person_ids'] as row from app.assistant_own_leave_review r where id=${id}::uuid`)),beforeIdentity=await identity(),beforeCapture=await capture(id);expect(beforeCapture.rows).toEqual([]); // Pending review has no completed effect capture; nonempty completed retention is covered separately.
  await unlockClosedBatch(ctx,{batchId,reason});await resetProcessedBatch(ctx,{batchId,reason});await deleteDraftBatch(ctx,{batchId});
  const [retired]=await owner.db.execute<{state:string;people:unknown;intent:unknown;digest:unknown;body:number}>(sql`select state,payroll_reopen_person_ids people,intent_digest intent,reviewed_digest digest,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) body from app.assistant_own_leave_review r where id=${id}::uuid`);expect(retired).toEqual({state:'refused',people:null,intent:null,digest:null,body:0});expect(await identity()).toEqual(beforeIdentity);expect(await capture(id)).toEqual(beforeCapture);expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,sibling))).toEqual(siblingBefore);expect((await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.id,periodId))).length).toBe(1);
 });

});
