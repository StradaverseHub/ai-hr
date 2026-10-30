import {assertReviewBodyPendingParentContract} from './helpers/review-body-pending-parent-contract';
import {prepareReviewedPayrollReopenSourceTx,confirmReviewedPayrollReopenSourceTx} from '../core/assistant-actions/reviewed-payroll-reopen-source';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {erasePersonPii} from '../core/pdpa';
import {assignRole} from '../core/admin';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createBatch,generatePayslips,closeBatch,unlockClosedBatch,createAdditionalRun,setPayrollPermissionGrant} from '../packs/payroll/service';
import {preparePayrollReopenReview,confirmPayrollReopenReview,reopenPayrollReopenReview,discardPayrollReopenReview,listPayrollReopenReviews,readPayrollReopenChoices} from '../core/assistant-actions/payroll-reopen-review-store';
import {preparePayrollCloseReview} from '../core/assistant-actions/payroll-close-review-store';
import {PayrollReopen as C} from '../lib/assistant-actions/reviewed-payroll-reopen-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,outsider:SessionContext,employmentId:string,personId:string,batchId:string,period:string;
const action=C.action;
const human=()=>({action,contractVersion:1,batchId,reason:'Fictional human correction',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true});
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const retirement=(r:{actionId:string})=>({action,contractVersion:1,actionId:r.actionId});
async function prepare(){const result=await preparePayrollReopenReview(ctx,human());if(result.kind!=='prepared')throw Error('Expected prepared reopen');return result.review;}
const confirm=(r:{actionId:string;reviewedDigest:string},who=ctx)=>confirmPayrollReopenReview(who,confirmation(r));
async function state(){return{batch:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)),slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId,b.tenantId)).orderBy(s.payslip.id),history:await owner.db.select().from(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId)).orderBy(s.payrollStatusHistory.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select to_regprocedure('app.assistant_payroll_reopen_review_complete(uuid,text,uuid)') is not null and to_regprocedure('app.payroll_close_source_people(uuid,uuid,uuid[])') is not null as ok`);expect(installed.ok,'Coordinated Payroll close custody/source drafts must be installed.').toBe(true);});afterAll(closeAll);afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-payroll-reopen-key-123456');await resetDb();b=await seedBase();for(const code of ['assistant','payroll','multi_cycle_payroll'] as const)await setModule(b.tenantId,code,'active');const [actor]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional Payroll close actor',primaryEmail:randomUUID()+'@fixture.test'}).returning();await owner.db.update(s.appUser).set({personId:actor.id}).where(eq(s.appUser.id,b.adminUserId));ctx={...await entitledCtx(b,['hr_admin']),personId:actor.id,grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});const [year,month]=todayInKualaLumpur().split('-').map(Number);period=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);const hiredOn=String(year-2)+'-01-01',hired=await hireEmployee(ctx,{person:{fullName:'PRIVATE fictional Payroll employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});employmentId=hired.employmentId;personId=hired.personId;await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:hiredOn});await requirePackFor('MY').statutory.set(ctx,{personId,icNumber:'900101019885'});batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await generatePayslips(ctx,{batchId});await closeBatch(ctx,{batchId});await setSetting(b.tenantId,'payroll.unlock_enabled',true);ctx={...await entitledCtx(b,['hr_admin']),personId:actor.id,grants:[{role:'hr_admin',companyId:null}]};const [other]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional separate login',primaryEmail:randomUUID()+'@fixture.test'}).returning(),userId=await createAppUser(b.tenantId,other.id,'employee');outsider={...await entitledCtx(b,['employee']),userId,personId:other.id,grants:[{role:'employee',companyId:null}]};await grantAssistant(ctx,{appUserId:userId});});
describe('Payroll reopening complete native/custody effect',()=>{
 it('records exact history, run event and conditional parent event in one Tx, keeps payslips/totals, retires encrypted body, and replays same ID without executing again',async()=>{
  const before=await state(),r=await prepare();expect(r.review).toMatchObject({beforeStatus:'closed',afterStatus:'processed',beforePeriodStatus:'closed',parentWillReopen:true});
  expect(JSON.stringify(r)).not.toContain('PRIVATE fictional Payroll employee');
  const done=await confirm(r);if(done.kind!=='completed')throw Error('Expected completed reopening');
  // Shared custody reconciles even its first completed response; replayed describes receipt reading, not a second effect.
  const receipt=done.receipt.receipt;expect(receipt).toMatchObject({batchId,currentStatus:'processed',currentPeriodStatus:'open',parentWasReopened:true,replayed:true});
  const after=await state();expect(after.history.filter(row=>row.action==='unlock')).toHaveLength(1);expect(after.events.filter(row=>row.aggregateId===batchId&&row.eventType==='payroll-batch.unlocked')).toHaveLength(1);expect(after.slips).toEqual(before.slips);expect(after.batch[0].totals).toEqual(before.batch[0].totals);expect(after.batch[0].releasedAt).toEqual(before.batch[0].releasedAt);
  const history=after.history.find(row=>row.id===receipt.statusHistoryId);expect(history).toMatchObject({batchId,action:'unlock',fromStatus:'closed',toStatus:'processed',reason:human().reason});
  const event=after.events.find(row=>row.id===receipt.unlockedEventId);expect(event).toMatchObject({aggregateId:batchId,eventType:'payroll-batch.unlocked',actorId:ctx.userId});expect(event!.payload).toMatchObject({statusHistoryId:receipt.statusHistoryId,periodReopenedEventId:receipt.periodReopenedEventId,reopenedPeriod:true});
  const parent=after.events.find(row=>row.id===receipt.periodReopenedEventId);expect(parent).toMatchObject({aggregateId:receipt.payPeriodId,eventType:'pay-period.reopened'});
  const [stored]=await owner.db.execute<{bodies:number;state:string;people:unknown}>(sql`select r.state,r.payroll_reopen_person_ids people,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) bodies from app.assistant_own_leave_review r where r.id=${r.actionId}::uuid`);expect(stored).toEqual({state:'completed',people:null,bodies:0});
  const again=await confirm(r);if(again.kind!=='completed')throw Error();expect(again.receipt.receipt).toMatchObject({unlockedEventId:receipt.unlockedEventId,replayed:true});expect(await state()).toEqual(after);
  await closeBatch(ctx,{batchId});const reclosed=await state(),recovered=await reopenPayrollReopenReview(ctx,r.actionId);if(recovered.kind!=='completed')throw Error();expect(recovered.receipt.receipt.currentStatus).toBe('closed');expect(await state()).toEqual(reclosed);
 });
 it('supports a USER with no linked PERSON without inventing employment',async()=>{await owner.db.update(s.appUser).set({personId:null}).where(eq(s.appUser.id,ctx.userId!));ctx={...ctx,personId:undefined};const r=await prepare();const done=await confirm(r);expect(done.kind).toBe('completed');const [row]=await owner.db.execute<{person_id:unknown;employment_id:unknown}>(sql`select person_id,employment_id from app.assistant_own_leave_review where id=${r.actionId}::uuid`);expect(row).toEqual({person_id:null,employment_id:null});});
 it('refuses a changed recorded-export warning and source with zero business effects',async()=>{const r=await prepare();await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'payroll-batch',aggregateId:batchId,eventType:'payroll-batch.payment-summary.exported',actorType:'user',actorId:ctx.userId,payload:{}});const before=await state();await expect(confirm(r)).rejects.toThrow();expect(await state()).toEqual(before);});
 it('refuses wrong token, foreign actor, SYSTEM and injected authority fields without a change',async()=>{const r=await prepare(),before=await state();await expect(confirm({...r,reviewedDigest:'0'.repeat(64)})).rejects.toThrow();await expect(confirm(r,outsider)).rejects.toThrow();await expect(confirm(r,{...ctx,userId:undefined})).rejects.toThrow();for(const extra of [{force:true},{amount:1},{service:'unlockClosedBatch'},{reason:' '},{confirmReopenClosedRun:false}])await expect(preparePayrollReopenReview(ctx,{...human(),...extra})).rejects.toThrow();expect(await state()).toEqual(before);});
 it('repeats the configurable native unlock permission at confirmation and allows metadata/discard after revocation',async()=>{const r=await prepare();await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'payroll.unlock',role:'hr_admin',allowed:false});await revokeAssistant(ctx,{appUserId:ctx.userId!});const before=await state();await expect(confirm(r)).rejects.toThrow();expect((await listPayrollReopenReviews(ctx)).reviews.map(row=>row.actionId)).toContain(r.actionId);expect((await discardPayrollReopenReview(ctx,retirement(r))).receipt.state).toBe('discarded');expect(await state()).toEqual(before);});
 it('refuses disabled switch before prepare or effect, and bounds native choices',async()=>{expect((await readPayrollReopenChoices(ctx)).kind).toBe('choices');await setSetting(b.tenantId,'payroll.unlock_enabled',false);ctx={...await entitledCtx(b,['hr_admin']),personId:ctx.personId,grants:[{role:'hr_admin',companyId:null}]};const before=await state();await expect(prepare()).rejects.toThrow();expect(await state()).toEqual(before);});
 it('retires expired review bodies and cannot attach unrelated native events',async()=>{const r=await prepare();const before=await state();await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_payroll_reopen_review_complete(${r.actionId}::uuid,${r.reviewedDigest},${randomUUID()}::uuid)`))).rejects.toThrow();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);const retired=await reopenPayrollReopenReview(ctx,r.actionId);expect(retired.kind).toBe('retired');expect(await state()).toEqual(before);});
 it('preserves actual native audit INSERT authority despite a configured payroll-partner unlock grant',async()=>{
  const userId=await createAppUser(b.tenantId,null,'employee');await assignRole(ctx,{appUserId:userId,role:'payroll_partner',companyId:b.companyId});await grantAssistant(ctx,{appUserId:userId});
  const partner={...await entitledCtx(b,['employee','payroll_partner']),userId,personId:undefined,grants:[{role:'employee' as const,companyId:null},{role:'payroll_partner' as const,companyId:b.companyId}]};
  await expect(preparePayrollReopenReview(partner,human())).rejects.toThrow();
  await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'payroll.unlock',role:'payroll_partner',allowed:true});
  const before=await state();let failure:unknown;try{await unlockClosedBatch(partner,{batchId,reason:human().reason});}catch(e){failure=e;}
  const denied=failure as {code?:string;cause?:{code?:string}}|undefined;expect(denied?.cause?.code??denied?.code).toBe('42501');expect(await state()).toEqual(before);
  await expect(preparePayrollReopenReview(partner,human())).rejects.toThrow();const choices=await readPayrollReopenChoices(partner);if(choices.kind==='choices')expect(choices.batches).toEqual([]);expect(await state()).toEqual(before);
 });
 it('erases the complete affected run cohort encrypted review without changing payroll data',async()=>{
  const r=await prepare(),before=await state();await erasePersonPii(ctx,{subjectEmploymentId:employmentId,scope:'contact',requestRef:'FICTIONAL-REOPEN-ERASURE',reason:'Fictional run-cohort privacy request'});
  const [stored]=await owner.db.execute<{state:string;people:unknown;bodies:number}>(sql`select r.state,r.payroll_reopen_person_ids people,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where r.id=${r.actionId}::uuid`);
  expect(stored).toEqual({state:'refused',people:null,bodies:0});const after=await state();expect(after.batch).toEqual(before.batch);expect(after.slips).toEqual(before.slips);expect(after.events.some(e=>e.eventType==='pii.erased'&&(e.payload as {erasedFields?:string[]})?.erasedFields?.includes('assistantPreparedReviews'))).toBe(true);
 });
 it('rolls back when warning evidence changes inside the native update after its warning reader',async()=>{
  const r=await prepare(),before=await state();await owner.db.execute(sql`create function app.fictional_reopen_export_race() returns trigger language plpgsql as $$begin if NEW.status='processed' and OLD.status='closed' then insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(NEW.tenant_id,'payroll-batch',NEW.id,'payroll-batch.payment-summary.exported','user',app.current_user_id(),'{}'::jsonb);end if;return NEW;end$$`);await owner.db.execute(sql`create trigger fictional_reopen_export_race after update on public.payroll_batch for each row execute function app.fictional_reopen_export_race()`);
  try{await expect(confirm(r)).rejects.toThrow();expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger fictional_reopen_export_race on public.payroll_batch`);await owner.db.execute(sql`drop function app.fictional_reopen_export_race()`);}
 });

 it('keeps each legacy dedicated column forbidden for reopening and new reopening columns forbidden for close',async()=>{
  const r=await prepare();const columns=await owner.db.execute<{name:string;type:string}>(sql`select attname name,format_type(atttypid,atttypmod) type from pg_attribute where attrelid='app.assistant_own_leave_review'::regclass and attnum>0 and not attisdropped and attname not in('action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','payroll_reopen_batch_id','payroll_reopen_period_id','payroll_reopened_event_id','payroll_reopen_person_ids') order by attnum`);
  expect(columns.length).toBeGreaterThan(40);
  const codes=(e:unknown)=>{const x=e as {code?:string;cause?:{code?:string}};return x.cause?.code??x.code;};
  for(const c of columns){const value=c.type==='uuid'?"'10000000-0000-4000-8000-000000000099'::uuid":c.type==='uuid[]'?"ARRAY['10000000-0000-4000-8000-000000000099'::uuid]":c.type==='date'?"'2026-01-01'::date":c.type.includes('int')?'1':c.type==='boolean'?'true':c.type==='jsonb'?"'{}'::jsonb":c.type==='xid8'?"'1'::xid8":c.type==='tid'?"'(0,1)'::tid":"'hybrid'";let caught:unknown;try{await owner.db.execute(sql.raw(`update app.assistant_own_leave_review set "${c.name}"=${value} where id='${r.actionId}'::uuid`));}catch(e){caught=e;}expect(codes(caught),c.name).toBe('23514');}
  await unlockClosedBatch(ctx,{batchId,reason:'Fictional close hybrid fixture'});const close=await preparePayrollCloseReview(ctx,{action:'payroll.close',contractVersion:1,batchId,confirmCloseProcessedRun:true});if(close.kind!=='prepared')throw Error();let caught:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set payroll_reopen_batch_id=${batchId}::uuid where id=${close.review.actionId}::uuid`);}catch(e){caught=e;}expect(codes(caught)).toBe('23514');
  const [sizes]=await owner.db.execute<{count:number;max:number;total:number}>(sql`select count(*)::int count,max(octet_length(pg_get_expr(conbin,conrelid)))::int max,sum(octet_length(pg_get_expr(conbin,conrelid)))::int total from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c'`);console.info('Payroll custody CHECK bytes',sizes);expect(sizes.count).toBeGreaterThan(10);
 });

 it('keeps the private native review stable across committed custody preparation, then executes through the direct source owner',async()=>{
  const before=await withTenant(ctx,tx=>prepareReviewedPayrollReopenSourceTx(tx,ctx,human()));
  await prepare();
  const fresh=await withTenant(ctx,tx=>prepareReviewedPayrollReopenSourceTx(tx,ctx,human()));
  expect(fresh.reviewedDigest===before.reviewedDigest,'Native source changed during custody-only preparation').toBe(true);
  const done=await withTenant(ctx,tx=>confirmReviewedPayrollReopenSourceTx(tx,ctx,human(),fresh.reviewedDigest));
  expect(done.receipt).toMatchObject({batchId,currentStatus:'processed',parentWasReopened:true,replayed:false});
 });
 it('reopens a still-pending review without changing its private source or business state',async()=>{
  const r=await prepare(),before=await state();const pending=await reopenPayrollReopenReview(ctx,r.actionId);expect(pending.kind).toBe('prepared');expect(await state()).toEqual(before);
 });

 it('reopens only the selected run while an already-open parent and sibling draft remain unchanged, with no parent event',async()=>{
  await unlockClosedBatch(ctx,{batchId,reason:'Fictional sibling fixture'});
  const sibling=await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'});
  await closeBatch(ctx,{batchId});
  const [beforeSibling]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,sibling.batchId));
  const r=await prepare();expect(r.review).toMatchObject({beforePeriodStatus:'open',parentWillReopen:false});
  const done=await confirm(r);if(done.kind!=='completed')throw Error('Expected completed reopening');
  expect(done.receipt.receipt).toMatchObject({batchId,parentWasReopened:false,periodReopenedEventId:null,currentPeriodStatus:'open'});
  const [afterSibling]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,sibling.batchId));expect(afterSibling).toEqual(beforeSibling);
 });

});

it('shared body contract: real Payroll pending writes and terminal retarget refusal',async()=>{await assertReviewBodyPendingParentContract({ctx,kind:C.action,businessSnapshot:state,prepare,retire:r=>discardPayrollReopenReview(ctx,retirement(r))});});
