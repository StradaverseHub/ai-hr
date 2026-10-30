/** Hosted migrated-DB tests only. Actual DELETE/deferred trigger; bounded real-USER fanout. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {createEmployeeDraftWithReservedCode,saveEmployeeDraft,discardEmployeeDraft,saveAndCompleteEmployeeDraft} from '../core/employee-draft';
import {createConfig} from '../core/employee-id-config';
import {grantAssistant} from '../core/assistant-grant';
import {employeeDraftActivationReviews as activation} from '../core/assistant-actions/employee-draft-activation-review-store';
import {employeeDraftDiscardReviews as discard} from '../core/assistant-actions/employee-draft-discard-review-store';
import {EmployeeDraftActivation as A} from '../lib/assistant-actions/employee-draft-activation-contract';
import {EmployeeDraftDiscard as D} from '../lib/assistant-actions/employee-draft-discard-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
const INTENT='a'.repeat(64),REVIEWED='b'.repeat(64),KID='0123456789abcdef';
type Kind='activate'|'discard';
type Draft=Awaited<ReturnType<typeof draft>>;
const group=(base=b)=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-cleanup-envelope-key-12345678');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle',null);await grantAssistant(group(),{appUserId:b.adminUserId});ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};});
async function user(base=b){const userId=await createAppUser(base.tenantId,null,'hr_admin');await grantAssistant(group(base),{appUserId:userId});return{...await entitledCtx(base,['hr_admin']),userId,personId:null,grants:[{role:'hr_admin' as const,companyId:null}]};}
async function draft(who=ctx,base=b,configured=false){
 if(configured)await createConfig(who,{companyId:base.companyId,prefix:'CLEAN',startNumber:10,numberLength:4,increment:3,allowManualOverride:true});
 const d=await createEmployeeDraftWithReservedCode(who,{companyId:base.companyId,fullName:'Fictional cleanup draft',primaryEmail:randomUUID()+'@fixture.test',...(!configured?{employeeIdMode:'manual' as const,employeeCode:'CLEAN-'+randomUUID().slice(0,8)}:{})});
 const data={profile:{fullName:'Fictional cleanup draft',primaryEmail:randomUUID()+'@fixture.test',employeeCode:d.employeeCode,employeeIdMode:configured?'auto':'manual'},employment:{companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'3000',monthlyAllowance:'100',payMode:'monthly',paymentTerm:'monthly',remarks:'Fictional captured input'}};
 await saveEmployeeDraft(who,{id:d.id,data,currentStep:4});return{...d,data,companyId:base.companyId};
}
/** Closed SQL preparation creates actual caller-bound pending rows and obeys existing per-USER
 * limits. Synthetic bounded envelopes are never decrypted or claimed as human completion proof. */
async function prepare(kind:Kind,d:Pick<Draft,'id'|'companyId'>,who=ctx){const id=randomUUID();await withTenant(who,async tx=>{
 if(kind==='activate')await tx.execute(sql`select app.assistant_employee_draft_activation_command('prepare',${id}::uuid,${who.personId??null}::uuid,${d.companyId}::uuid,${d.id}::uuid,${INTENT},${REVIEWED},${KID},${'fixture-wrapped-key'},${'fixture-ciphertext'})`);
 else{const [source]=await tx.execute<{value:{sourceDigest:string}}>(sql`select app.assistant_employee_draft_discard_command('source',NULL,${who.personId??null}::uuid,${d.companyId}::uuid,${d.id}::uuid) as value`);await tx.execute(sql`select app.assistant_employee_draft_discard_command('prepare',${id}::uuid,${who.personId??null}::uuid,${d.companyId}::uuid,${d.id}::uuid,${INTENT},${REVIEWED},${KID},${'fixture-wrapped-key'},${'fixture-ciphertext'},${source.value.sourceDigest})`);}
 });return id;}
async function both(d:Pick<Draft,'id'|'companyId'>,who=ctx){return{activation:await prepare('activate',d,who),discard:await prepare('discard',d,who)};}
async function pending(d:Pick<Draft,'id'>,tenant=b.tenantId){const [row]=await owner.db.execute<{reviews:number;bodies:number}>(sql`select count(*)::int reviews,count(c.action_id)::int bodies from app.assistant_own_leave_review r left join app.assistant_own_leave_review_content c on c.action_id=r.id where r.tenant_id=${tenant}::uuid and r.receipt_subject_kind='employee_draft' and r.receipt_subject_id=${d.id}::uuid and r.action_kind in ('employees.draft.activate','employees.draft.discard') and r.state='awaiting_confirmation'`);return row;}
async function retiredRows(d:Pick<Draft,'id'>){return Array.from(await owner.db.execute<{id:string;state:string;body:boolean;source:boolean;sourceXmin:boolean;sourceCtid:boolean;stamp:boolean;deleteXid:boolean;arm:boolean}>(sql`select r.id,r.state,exists(select 1 from app.assistant_own_leave_review_content c where c.action_id=r.id) body,r.draft_discard_source is not null source,r.draft_discard_source_xmin is not null "sourceXmin",r.draft_discard_source_ctid is not null "sourceCtid",r.draft_discard_delete_witness is not null stamp,r.draft_discard_delete_xid is not null "deleteXid",r.draft_discard_capture_xid is not null arm from app.assistant_own_leave_review r where r.tenant_id=${b.tenantId}::uuid and r.receipt_subject_id=${d.id}::uuid and r.receipt_subject_kind='employee_draft' order by r.id`));}
async function snapshot(tenant=b.tenantId){return{
 drafts:await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.tenantId,tenant)).orderBy(s.employeeDraft.id),
 configs:await owner.db.select().from(s.employeeIdConfig).where(eq(s.employeeIdConfig.tenantId,tenant)).orderBy(s.employeeIdConfig.id),
 counters:await owner.db.select().from(s.tenantCounter).where(eq(s.tenantCounter.tenantId,tenant)).orderBy(s.tenantCounter.kind),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,tenant)).orderBy(s.domainEvent.id),
 reviews:Array.from(await owner.db.execute(sql`select r.id,r.state,r.intent_digest,r.reviewed_digest,r.receipt_event_id,r.draft_discard_source,r.draft_discard_source_xmin,r.draft_discard_source_ctid::text,r.draft_discard_delete_witness,r.draft_discard_delete_xid::text,r.draft_discard_capture_xid::text,exists(select 1 from app.assistant_own_leave_review_content c where c.action_id=r.id) body from app.assistant_own_leave_review r where r.tenant_id=${tenant}::uuid order by r.id`)),
};}
async function gui(operation:'discard'|'activate',d:Draft){if(operation==='discard')await discardEmployeeDraft(ctx,d.id);else await saveAndCompleteEmployeeDraft(ctx,{id:d.id,data:d.data,currentStep:4});}
async function noPending(d:Draft){expect(await pending(d)).toEqual({reviews:0,bodies:0});const rows=await retiredRows(d);for(const row of rows){if(row.state==='completed')continue;expect(row).toMatchObject({state:'discarded',body:false,source:false,sourceXmin:false,sourceCtid:false,stamp:false,deleteXid:false,arm:false});}}

it.each(['none','activation','discard','both'] as const)('default native discard preserves the %s current-kind course and retires other USERs at COMMIT',async current=>{const d=await draft();for(let i=0;i<2;i++)await both(d,await user());if(current==='activation'||current==='both')await prepare('activate',d);if(current==='discard'||current==='both')await prepare('discard',d);expect((await pending(d)).reviews).toBeGreaterThanOrEqual(4);await gui('discard',d);await noPending(d);expect(await owner.db.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,d.id))).toHaveLength(0);});
it.each(['none','activation','discard','both'] as const)('default native activation preserves the %s current-kind course and retires other USERs at COMMIT',async current=>{const d=await draft();for(let i=0;i<2;i++)await both(d,await user());if(current==='activation'||current==='both')await prepare('activate',d);if(current==='discard'||current==='both')await prepare('discard',d);await gui('activate',d);await noPending(d);expect(await owner.db.select({id:s.employment.id}).from(s.employment).where(eq(s.employment.employeeCode,d.employeeCode))).toHaveLength(1);});
it.each(['activate','discard'] as const)('retains the current legitimate %s completion while retiring the other current kind and other USERs',async kind=>{const d=await draft();for(let i=0;i<2;i++)await both(d,await user());const a=await activation.prepare(ctx,{action:A.action,contractVersion:1,draftId:d.id,companyId:b.companyId}),p=await discard.prepare(ctx,{action:D.action,contractVersion:1,draftId:d.id,companyId:b.companyId,consent:'discard_saved_draft_captured_input'});if(a.kind!=='prepared'||p.kind!=='prepared')throw Error('Expected two genuine human reviews');const done=kind==='activate'?await activation.confirm(ctx,{action:A.action,contractVersion:1,actionId:a.review.actionId,reviewedDigest:a.review.reviewedDigest}):await discard.confirm(ctx,{action:D.action,contractVersion:1,draftId:d.id,companyId:b.companyId,consent:'discard_saved_draft_captured_input',actionId:p.review.actionId,reviewedDigest:p.review.reviewedDigest});expect(done.kind).toBe('completed');await noPending(d);const rows=await retiredRows(d),currentId=kind==='activate'?a.review.actionId:p.review.actionId;expect(rows.find(row=>row.id===currentId)).toMatchObject({state:'completed',body:false});expect(rows.filter(row=>row.state==='completed')).toHaveLength(1);});
it('cleans eight distinct real USERs without bypassing any per-USER review limit or imposing a global fanout cap',async()=>{const d=await draft();for(let i=0;i<8;i++)await both(d,await user());expect(await pending(d)).toEqual({reviews:16,bodies:16});const counts=Array.from(await owner.db.execute<{n:number}>(sql`select count(*)::int n from app.assistant_own_leave_review where tenant_id=${b.tenantId}::uuid and receipt_subject_id=${d.id}::uuid and state='awaiting_confirmation' group by user_id`));expect(counts).toHaveLength(8);expect(counts.every(row=>row.n===2)).toBe(true);await gui('discard',d);await noPending(d);});
it('leaves unrelated draft/tenant pending custody and an existing completed receipt unchanged',async()=>{const completedDraft=await draft(),r=await discard.prepare(ctx,{action:D.action,contractVersion:1,draftId:completedDraft.id,companyId:b.companyId,consent:'discard_saved_draft_captured_input'});if(r.kind!=='prepared')throw Error('Expected prepared');const completed=await discard.confirm(ctx,{action:D.action,contractVersion:1,draftId:completedDraft.id,companyId:b.companyId,consent:'discard_saved_draft_captured_input',actionId:r.review.actionId,reviewedDigest:r.review.reviewedDigest});expect(completed.kind).toBe('completed');const target=await draft(),unrelated=await draft();await both(target);await both(unrelated);const other=await seedBase();await setModule(other.tenantId,'assistant','active');await setModule(other.tenantId,'lifecycle',null);const otherUser=await user(other),foreign=await draft(otherUser,other);await both(foreign,otherUser);const foreignBefore=await snapshot(other.tenantId),unrelatedBefore=await retiredRows(unrelated),completedBefore=(await retiredRows(completedDraft))[0];await gui('discard',target);await noPending(target);expect(await retiredRows(unrelated)).toEqual(unrelatedBefore);expect((await retiredRows(completedDraft))[0]).toEqual(completedBefore);expect(await snapshot(other.tenantId)).toEqual(foreignBefore);});
it.each(['review','body'] as const)('NOWAIT on a late ordered %s lock rolls back earlier retirements, draft, counter and event effects',async kind=>{const d=await draft(ctx,b,true);for(let i=0;i<3;i++)await both(d,await user());const [last]=await owner.db.execute<{id:string}>(sql`select id from app.assistant_own_leave_review where tenant_id=${b.tenantId}::uuid and receipt_subject_id=${d.id}::uuid and state='awaiting_confirmation' order by id desc limit 1`),before=await snapshot();let error:unknown;await owner.db.transaction(async held=>{if(kind==='review')await held.execute(sql`select id from app.assistant_own_leave_review where id=${last.id}::uuid for update`);else await held.execute(sql`select action_id from app.assistant_own_leave_review_content where action_id=${last.id}::uuid for update`);try{await gui('discard',d);}catch(cause){error=cause;}});expect(pgSqlState(error)).toBe('55P03');expect(pgErrorChain(error).some(link=>(link.message??'').includes('could not obtain lock'))).toBe(true);expect(await snapshot()).toEqual(before);});
it('body-only owner lock then Access request cannot create a body-owner/Access cycle or partially retire earlier rows',async()=>{
 const d=await draft(ctx,b,true);for(let i=0;i<3;i++)await both(d,await user());
 const [last]=await owner.db.execute<{id:string}>(sql`select id from app.assistant_own_leave_review where tenant_id=${b.tenantId}::uuid and receipt_subject_id=${d.id}::uuid and state='awaiting_confirmation' order by id desc limit 1`),before=await snapshot();
 await owner.db.transaction(async held=>{
  await held.execute(sql`set local lock_timeout='3s'`);
  await held.execute(sql`select action_id from app.assistant_own_leave_review_content where action_id=${last.id}::uuid for update`);
  let reached!:()=>void,release!:()=>void;
  const reachedAccess=new Promise<void>(resolve=>{reached=resolve;}),continueCommit=new Promise<void>(resolve=>{release=resolve;});
  const native=withTenant(ctx,async tx=>{await discardEmployeeDraft(ctx,d.id,tx);reached();await continueCommit;}).then(()=>({ok:true as const,error:undefined}),error=>({ok:false as const,error}));
  let waiting:Promise<unknown>|undefined,result:Awaited<typeof native>|undefined,waitingResult:PromiseSettledResult<unknown>|undefined;
  try{
   await Promise.race([reachedAccess,native.then(early=>{if(!early.ok)throw early.error;throw Error('Native transaction finished before its commit gate');})]);
   const [owned]=await held.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) owned`);expect(owned.owned).toBe(false);
   const [backend]=await held.execute<{pid:number}>(sql`select pg_backend_pid() pid`);
   waiting=held.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`).then(value=>value);
   void waiting.catch(()=>undefined); // Observe early driver refusal; final allSettled still asserts its result.
   let queued=false;
   for(let attempt=0;attempt<50;attempt++){
    const [row]=await owner.db.execute<{queued:boolean}>(sql`select exists(select 1 from pg_locks where pid=${backend.pid} and locktype='advisory' and not granted) queued`);
    if(row.queued){queued=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(queued).toBe(true);
  }finally{
   // Every early native error/assertion releases the continuation and settles BOTH sessions.
   release();const settled=await Promise.allSettled([native,waiting??Promise.resolve()]);result=await native;waitingResult=settled[1];
  }
  expect(result?.ok).toBe(false);expect(pgSqlState(result?.error)).toBe('55P03');
  expect(pgErrorChain(result?.error).some(link=>(link.message??'').includes('could not obtain lock'))).toBe(true);
  expect(waitingResult?.status).toBe('fulfilled');
 });
 expect(await snapshot()).toEqual(before);
});
it('permits row-only retirement when a pending body is already missing',async()=>{const d=await draft(),id=await prepare('discard',d);await owner.db.execute(sql`delete from app.assistant_own_leave_review_content where action_id=${id}::uuid`);await gui('discard',d);await noPending(d);expect((await retiredRows(d)).find(row=>row.id===id)).toMatchObject({state:'discarded',body:false,source:false,sourceXmin:false,sourceCtid:false,stamp:false,deleteXid:false,arm:false});});
// Historical case key retained for authenticated recovery. This cut installs the new kind and body
// guard together, so no reachable legacy terminal-body fixture exists. Prove refusal and GUI liveness;
// never disable a trigger or pretend that a rejected INSERT established an orphan preservation proof.
it('leaves an already-terminal legacy body orphan outside the pending-cleanup claim without permanent GUI refusal',async()=>{
 const d=await draft(),id=await prepare('discard',d);await withTenant(ctx,tx=>tx.execute(sql`select app.assistant_employee_draft_discard_command('discard',${id}::uuid)`));
 const terminal=(await retiredRows(d)).find(row=>row.id===id);expect(terminal).toMatchObject({state:'discarded',body:false,source:false,sourceXmin:false,sourceCtid:false,stamp:false,deleteXid:false,arm:false});const before=await snapshot();
 let failure:unknown;try{await owner.db.execute(sql`insert into app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) values(${id}::uuid,${KID},${'fixture-wrapped-key'},${'fixture-terminal-orphan'})`);}catch(error){failure=error;}
 expect(pgSqlState(failure)).toBe('42501');expect(pgErrorChain(failure).some(link=>link.message==='Review body requires pending parent')).toBe(true);expect(await snapshot()).toEqual(before);
 await gui('discard',d);expect(await pending(d)).toEqual({reviews:0,bodies:0});expect((await retiredRows(d)).find(row=>row.id===id)).toEqual(terminal);expect(await owner.db.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,d.id))).toEqual([]);
});
it('forced early cleanup makes later Assistant completion refuse and rolls the WHOLE native transaction back',async()=>{const d=await draft(ctx,b,true),id=await prepare('discard',d),before=await snapshot();let error:unknown;try{await withTenant(ctx,async tx=>{await tx.execute(sql`select app.assistant_employee_draft_discard_command('source',NULL,${ctx.personId??null}::uuid,${b.companyId}::uuid,${d.id}::uuid)`);const actual=await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});await tx.execute(sql`set constraints assistant_employee_draft_delete_cleanup immediate`);await tx.execute(sql`select app.assistant_employee_draft_discard_command('complete',${id}::uuid,NULL,NULL,NULL,NULL,${REVIEWED},NULL,NULL,NULL,NULL,${actual.eventId}::uuid)`);});}catch(cause){error=cause;}expect(pgSqlState(error)).toBe('42501');expect(await snapshot()).toEqual(before);});
it('default native GUI deletion can truthfully commit retirement even when cleanup is forced IMMEDIATE',async()=>{const d=await draft();await both(d);await withTenant(ctx,async tx=>{await discardEmployeeDraft(ctx,d.id,tx);await tx.execute(sql`set constraints assistant_employee_draft_delete_cleanup immediate`);});await noPending(d);expect(await owner.db.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,d.id))).toHaveLength(0);});
it('rollback-only native preview leaves no deletion witness, native event, counter change or deferred retirement',async()=>{const d=await draft(ctx,b,true);await both(d);const before=await snapshot();await withTenant(ctx,async tx=>{await tx.execute(sql`savepoint cleanup_preview`);await discardEmployeeDraft(ctx,d.id,tx,{returnResult:true});await tx.execute(sql`rollback to savepoint cleanup_preview`);await tx.execute(sql`release savepoint cleanup_preview`);});expect(await snapshot()).toEqual(before);expect((await retiredRows(d)).every(row=>!row.stamp&&row.body&&row.state==='awaiting_confirmation')).toBe(true);});
it('uses actual expiry for a past-TTL pending row while retiring a live sibling without keeping either body',async()=>{const d=await draft(),expired=await prepare('discard',d),live=await prepare('activate',d);await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${expired}::uuid`);await gui('discard',d);expect(await pending(d)).toEqual({reviews:0,bodies:0});const rows=await retiredRows(d);expect(rows.find(row=>row.id===expired)).toMatchObject({state:'expired',body:false,source:false,sourceXmin:false,sourceCtid:false,stamp:false,deleteXid:false,arm:false});expect(rows.find(row=>row.id===live)).toMatchObject({state:'discarded',body:false});});
it('isolates same-tenant storage-owner TRY refusal with an owner-only rollback fault fixture, without claiming a naturally reachable canonical cycle',async()=>{
 const d=await draft(ctx,b,true);await both(d);const before=await snapshot();let error:unknown;
 await withTenant(ctx,async app=>{
  // The blocker owns ONLY canonical Access, no draft relation/tuple locks. Normal canonical owner
  // DELETE already takes Access before its rows, so this explicitly isolates defensive cleanup.
  await app.execute(sql`select app.access_workforce_write_lock()`);
  try{await owner.db.transaction(async raw=>{
   const [trusted]=await raw.execute<{trusted:boolean}>(sql`select app.access_workforce_storage_owner() trusted`);expect(trusted.trusted).toBe(true);
   await raw.execute(sql`select set_config('app.tenant_id',${b.tenantId},true)`);
   // Approved owner-privileged test fixture only. DDL rolls back with the expected failure;
   // actual row trigger and exact-table deferred trigger remain enabled throughout.
   await raw.execute(sql`alter table public.employee_draft disable trigger access_workforce_draft_lock`);
   await raw.execute(sql`set local lock_timeout='2s'`);
   await raw.execute(sql`delete from public.employee_draft where id=${d.id}::uuid`);
   const [same]=await raw.execute<{same:boolean}>(sql`select app.current_tenant_id()=${b.tenantId}::uuid same`);expect(same.same).toBe(true);
   await raw.execute(sql`set constraints assistant_employee_draft_delete_cleanup immediate`);
  });}catch(cause){error=cause;}
 });
 expect(pgSqlState(error)).toBe('55P03');expect(pgErrorChain(error).some(link=>(link.message??'').includes('Draft review cleanup busy'))).toBe(true);
 const [trigger]=await owner.db.execute<{enabled:string}>(sql`select tgenabled enabled from pg_trigger where tgrelid='public.employee_draft'::regclass and tgname='access_workforce_draft_lock'`);expect(trigger.enabled).toBe('O');expect(await snapshot()).toEqual(before);
 // A fresh ordinary native interval succeeds after the app barrier is released; no fixture DDL persists.
 await gui('discard',d);await noPending(d);
});
