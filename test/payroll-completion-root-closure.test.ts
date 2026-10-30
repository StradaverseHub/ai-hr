/** PRIVATE UNRUN: Payroll completion must seal the whole root transaction and exact history/privacy anchors.
 * Fictional real encrypted reviews; desired native outcome, no accepted FK failure.
 * UNRUN private fixture proposal: direct native SQL plus ordinary custody controls; no runtime claim. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {withTenant,type Tx,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {erasePersonPii} from '../core/pdpa';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {grantAssistant} from '../core/assistant-grant';
import {createBatch,generatePayslips,closeBatch,resetProcessedBatch,deleteDraftBatch,createAdditionalRun,setPayrollInput,unlockClosedBatchTx} from '../packs/payroll/service';
import {preparePayrollResetReview,confirmPayrollResetReview,discardPayrollResetReview,reopenPayrollResetReview} from '../core/assistant-actions/payroll-reset-review-store';
import {preparePayrollReopenReview,confirmPayrollReopenReview} from '../core/assistant-actions/payroll-reopen-review-store';
import {captureNativeOutcomeTargetsTx} from '../core/module-native-outcome-targets';
import {prepareReviewedPayrollResetSourceTx,confirmReviewedPayrollResetSourceTx} from '../core/assistant-actions/reviewed-payroll-reset-source';
import {prepareReviewedPayrollReopenSourceTx,confirmReviewedPayrollReopenSourceTx} from '../core/assistant-actions/reviewed-payroll-reopen-source';
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
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await setPayrollInput(ctx,{batchId,employmentId,overtimeAmount:0});await generatePayslips(ctx,{batchId});
 await setSetting(b.tenantId,'payroll.reset_enabled',true);await setSetting(b.tenantId,'payroll.unlock_enabled',true);
 ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 const [batch]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));periodId=batch.payPeriodId;
});
async function prepareReset(){const r=await preparePayrollResetReview(ctx,resetHuman());if(r.kind!=='prepared')throw Error('Expected real encrypted reset review');return r.review;}
async function state(){return{
 companies:await owner.db.select().from(s.company).where(eq(s.company.tenantId,b.tenantId)).orderBy(s.company.id),
 roles:await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.tenantId,b.tenantId)).orderBy(s.roleAssignment.id),
 access:await owner.db.execute(sql`select to_jsonb(c) as row from public.access_configuration c where tenant_id=${b.tenantId}::uuid`),
 overrides:await owner.db.execute(sql`select to_jsonb(o) as row from public.access_user_override o where tenant_id=${b.tenantId}::uuid order by id`),
 captures:await owner.db.execute(sql`select to_jsonb(c) as row from app.native_outcome_source_capture c where tenant_id=${b.tenantId}::uuid order by id`),
 targets:await owner.db.execute(sql`select to_jsonb(t) as row from app.native_outcome_source_target t join app.native_outcome_source_capture c on c.id=t.capture_id where c.tenant_id=${b.tenantId}::uuid order by t.capture_id,t.kind,t.target_id`),
 inputs:await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,batchId)).orderBy(s.payrollInput.id),
 batch:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)),
 parent:await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.id,periodId)),
 slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId)).orderBy(s.payslip.id),
 history:await owner.db.select().from(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId)).orderBy(s.payrollStatusHistory.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
 reviews:await owner.db.execute(sql`select to_jsonb(r) as row from app.assistant_own_leave_review r where tenant_id=${b.tenantId}::uuid order by id`),
 bodies:await owner.db.execute(sql`select to_jsonb(c) as row from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${b.tenantId}::uuid order by c.action_id`),
};}
function code(error:unknown){let next=error;for(let n=0;n<8&&next&&typeof next==='object';n++){const row=next as {code?:string;cause?:unknown};if(row.code)return row.code;next=row.cause;}return undefined;}
async function completeReset(tx:Tx,review:{actionId:string;reviewedDigest:string},expectInjected=false){
 const human=resetHuman(),fresh=await prepareReviewedPayrollResetSourceTx(tx,ctx,human);await tx.execute(sql`select set_config('app.payroll_reset_review_id',${review.actionId},true)`);const native=await confirmReviewedPayrollResetSourceTx(tx,ctx,human,fresh.reviewedDigest);
 await captureNativeOutcomeTargetsTx(tx,ctx,{action:'payroll.reset',sourceId:review.actionId,eventId:native.receipt.resetEventId,targets:[...native.targetPeople.map(id=>({kind:'person' as const,id})),...native.targetEmployees.map(id=>({kind:'employment' as const,id}))]});
 await tx.execute(sql`select app.assistant_payroll_reset_review_complete(${review.actionId}::uuid,${review.reviewedDigest},${native.receipt.resetEventId}::uuid)`);const [read]=await tx.execute<{value:unknown}>(sql`select app.read_own_payroll_reset_effect(${batchId}::uuid,${native.receipt.resetEventId}::uuid) value`);expect(read.value).not.toBeNull();if(expectInjected){const [input]=await tx.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,batchId));expect(input.overtimeAmount,'old SQL must actually expose the late mutation for this reproduction to be non-vacuous').toBe('1.00');}
}
async function completeReopen(tx:Tx,review:{actionId:string;reviewedDigest:string},expectInjected=false){
 const human={action:'payroll.reopen' as const,contractVersion:1 as const,batchId,reason,confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true},fresh=await prepareReviewedPayrollReopenSourceTx(tx,ctx,human),native=await confirmReviewedPayrollReopenSourceTx(tx,ctx,human,fresh.reviewedDigest);
 await captureNativeOutcomeTargetsTx(tx,ctx,{action:'payroll.reopen',sourceId:review.actionId,eventId:native.receipt.unlockedEventId,targets:[...native.targetPeople.map(id=>({kind:'person' as const,id})),...native.targetEmployees.map(id=>({kind:'employment' as const,id}))]});
 await tx.execute(sql`select app.assistant_payroll_reopen_review_complete(${review.actionId}::uuid,${review.reviewedDigest},${native.receipt.unlockedEventId}::uuid)`);const [read]=await tx.execute<{value:unknown}>(sql`select app.read_own_payroll_reopen_effect(${batchId}::uuid,${native.receipt.unlockedEventId}::uuid) value`);expect(read.value).not.toBeNull();if(expectInjected){const [input]=await tx.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,batchId));expect(input.overtimeAmount,'old SQL must actually expose the late mutation for this reproduction to be non-vacuous').toBe('1.00');}
}
describe('Payroll transaction-final closure, genuine app-role completion',()=>{
 it.each(['share','update'] as const)('retiring a body refuses a real competing parent %s lock with55P03 and rolls back the whole writer before the parent-first app command proceeds',async(mode)=>{
  const review=await prepareKind('reopen');
  const [pending]=await owner.db.execute<{phase:string;bodies:number}>(sql`select payroll_completion_root->>'phase' as phase,(select count(*)::integer from app.assistant_own_leave_review_content where action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${review.actionId}::uuid`);
  expect(pending).toEqual({phase:'prepared',bodies:1});
  const names=Array.from(await owner.db.execute<{name:string}>(sql`select tgname as name from pg_trigger where tgrelid='app.assistant_own_leave_review_content'::regclass and not tgisinternal order by tgname`)).map(row=>row.name);
  expect(names).toContain('assistant_payroll_completion_body_retired');expect(names.indexOf('assistant_payroll_completion_body_retired')).toBeLessThan(names.indexOf('assistant_payroll_reopen_body_retired'));
  // Fixture-only restricted app-callable lock owner. Production grants and legacy cleanup functions
  // are untouched. Both sessions use actual physical rows; no mocked locks or caught savepoint.
  await owner.db.execute(sql`create function app._fictional_payroll_pending_parent_lock(p uuid,exclusive_mode boolean) returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
   if exclusive_mode then perform 1 from app.assistant_own_leave_review where id=p and tenant_id=app.current_tenant_id() and user_id=app.current_user_id() and action_kind='payroll.reopen' and state='awaiting_confirmation' and payroll_completion_root->>'phase'='prepared' for update;
   else perform 1 from app.assistant_own_leave_review where id=p and tenant_id=app.current_tenant_id() and user_id=app.current_user_id() and action_kind='payroll.reopen' and state='awaiting_confirmation' and payroll_completion_root->>'phase'='prepared' for share;end if;
   if not found then raise exception 'Fictional actual pending row missing';end if;end$$`);
  await owner.db.execute(sql`revoke all on function app._fictional_payroll_pending_parent_lock(uuid,boolean) from public`);
  await owner.db.execute(sql`grant execute on function app._fictional_payroll_pending_parent_lock(uuid,boolean) to ai_hr_app`);
  let ready!:(pid:number)=>void,release!:()=>void;const acquired=new Promise<number>(resolve=>{ready=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  let writer:Promise<unknown>|undefined,timer:ReturnType<typeof setTimeout>|undefined,writerPid:number|undefined;
  const parent=withTenant(ctx,async tx=>{
   await tx.execute(sql`select app._fictional_payroll_pending_parent_lock(${review.actionId}::uuid,${mode==='update'})`);
   const [pid]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(pid.pid);await hold;
   const [retired]=await tx.execute<{value:{state:string}}>(sql`select app.assistant_payroll_reopen_review_discard(${review.actionId}::uuid) as value`);expect(retired.value.state).toBe('discarded');
  });
  void parent.catch(()=>undefined);
  try{
   const parentPid=await Promise.race([acquired,parent.then(()=>{throw Error('Actual parent lock did not remain held');})]),before=await state();let failure:unknown;
   try{
    writer=owner.db.transaction(async tx=>{
     const [pid]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);writerPid=pid.pid;expect(writerPid).not.toBe(parentPid);
     // A real preceding financial write makes whole-transaction rollback non-vacuous. This is an
     // OWNER adversary fixture, not an app authorization or alternate payroll money algorithm.
     const changed=await tx.update(s.payrollInput).set({overtimeAmount:'9.00'}).where(eq(s.payrollInput.batchId,batchId)).returning({id:s.payrollInput.id});expect(changed).toHaveLength(1);
     const removed=await tx.execute(sql`delete from app.assistant_own_leave_review_content where action_id=${review.actionId}::uuid returning action_id`);expect(Array.from(removed)).toHaveLength(1);
    });
    await Promise.race([writer,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{release();reject(Error('Body-to-parent writer blocked instead of refusing55P03'));},5000);})]);
   }catch(e){failure=e;}finally{if(timer)clearTimeout(timer);}
   expect(writerPid).toBeDefined();expect(code(failure)).toBe('55P03');expect(await state()).toEqual(before);
  }finally{
   release();try{const outcomes=await Promise.allSettled([parent,writer??Promise.resolve()]);expect(outcomes[0].status).toBe('fulfilled');}finally{await owner.db.execute(sql`drop function app._fictional_payroll_pending_parent_lock(uuid,boolean)`);}
  }
  const [after]=await owner.db.execute<{state:string;root:unknown;bodies:number}>(sql`select state,payroll_completion_root as root,(select count(*)::integer from app.assistant_own_leave_review_content where action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${review.actionId}::uuid`);expect(after).toEqual({state:'discarded',root:null,bodies:0});
  const [input]=await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,batchId));expect(input.overtimeAmount).toBe('0.00');
 });
 it('retires a genuine pending private source on uncontended body deletion while preserving native state and remaining review fields',async()=>{
  const review=await prepareKind('reopen'),before=await state();const [original]=await owner.db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(r) as row from app.assistant_own_leave_review r where id=${review.actionId}::uuid`);
  await owner.db.execute(sql`delete from app.assistant_own_leave_review_content where action_id=${review.actionId}::uuid`);
  const [actual]=await owner.db.execute<{row:Record<string,unknown>;bodies:number}>(sql`select to_jsonb(r) as row,(select count(*)::integer from app.assistant_own_leave_review_content where action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${review.actionId}::uuid`);
  expect(actual.row).toEqual({...original.row,payroll_completion_root:null,payroll_reopen_person_ids:null});expect(actual.bodies).toBe(0);expect(nativeState(await state())).toEqual(nativeState(before));
 });
 it('permits genuine parent-first app discard with private source present and no native financial effects',async()=>{
  const review=await prepareKind('reopen'),before=await state();const [retired]=await withTenant(ctx,tx=>tx.execute<{value:{state:string}}>(sql`select app.assistant_payroll_reopen_review_discard(${review.actionId}::uuid) as value`));expect(retired.value.state).toBe('discarded');
  const [row]=await owner.db.execute<{root:unknown;bodies:number}>(sql`select payroll_completion_root as root,(select count(*)::integer from app.assistant_own_leave_review_content where action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${review.actionId}::uuid`);expect(row).toEqual({root:null,bodies:0});expect(nativeState(await state())).toEqual(nativeState(before));
 });
 it('keeps the actual missing-parent cascade cleanup admitted',async()=>{
  const review=await prepareKind('reopen'),before=await state();const removed=await owner.db.execute(sql`delete from app.assistant_own_leave_review where id=${review.actionId}::uuid returning id`);expect(Array.from(removed)).toHaveLength(1);
  const [body]=await owner.db.execute<{count:number}>(sql`select count(*)::integer as count from app.assistant_own_leave_review_content where action_id=${review.actionId}::uuid`);expect(body.count).toBe(0);expect(nativeState(await state())).toEqual(nativeState(before));
 });
 it('keeps already-cleared pending body cleanup a no-op for the parent',async()=>{
  const review=await prepareKind('reopen');await owner.db.execute(sql`update app.assistant_own_leave_review set payroll_completion_root=null,payroll_reopen_person_ids=null where id=${review.actionId}::uuid`);const before=await state();
  await owner.db.execute(sql`delete from app.assistant_own_leave_review_content where action_id=${review.actionId}::uuid`);const after=await state();expect(after.reviews).toEqual(before.reviews);expect(nativeState(after)).toEqual(nativeState(before));expect(after.bodies).toHaveLength(0);
 });

 it.each(['reset','reopen'] as const)('%s refuses intermediate ancestor reparenting after forced IMMEDIATE for a genuine A-to-B-to-C scoped actor',async(kind)=>{
  const tree=await scopedTree(),review=await prepareKind(kind),before=await state();let failure:unknown;
  try{await withTenant(ctx,async tx=>{const [coverage]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${b.companyId}::uuid) as allowed`);expect(coverage.allowed).toBe(true);if(kind==='reset')await completeReset(tx,review);else await completeReopen(tx,review);await tx.execute(sql`set constraints all immediate`);await useActualGlobalActor(tx,tree.globalUser);const changed=await tx.update(s.company).set({parentCompanyId:tree.outside}).where(eq(s.company.id,tree.middle)).returning({id:s.company.id});expect(changed).toEqual([{id:tree.middle}]);await restoreScopedActor(tx);const [after]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${b.companyId}::uuid) as allowed`);expect(after.allowed).toBe(false);});}catch(e){failure=e;}
  expect(code(failure)).toBe('42501');expect(errorMessages(failure)).toContain('Payroll completion actor authority changed');expect(await state()).toEqual(before);
 });
 it('permits the same intermediate-ancestor reparenting in a later authorized independent transaction',async()=>{
  const tree=await scopedTree(),review=await prepareReset();await withTenant(ctx,tx=>completeReset(tx,review));await withTenant({...ctx,userId:tree.globalUser,grants:[{role:'hr_admin',companyId:null}]},async tx=>{const changed=await tx.update(s.company).set({parentCompanyId:tree.outside}).where(eq(s.company.id,tree.middle)).returning({id:s.company.id});expect(changed).toEqual([{id:tree.middle}]);});
  const [coverage]=await withTenant(ctx,tx=>tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${b.companyId}::uuid) as allowed`));expect(coverage.allowed).toBe(false);
 });
 it('permits an unrelated company ancestry edit in the same completed root without freezing the tenant tree',async()=>{
  const tree=await scopedTree(),[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated subtree',parentCompanyId:tree.outside}).returning({id:s.company.id}),review=await prepareReset();
  await withTenant(ctx,async tx=>{await completeReset(tx,review);await tx.execute(sql`set constraints all immediate`);await useActualGlobalActor(tx,tree.globalUser);const changed=await tx.update(s.company).set({parentCompanyId:null}).where(eq(s.company.id,other.id)).returning({id:s.company.id});expect(changed).toHaveLength(1);await restoreScopedActor(tx);const [coverage]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${b.companyId}::uuid) as allowed`);expect(coverage.allowed).toBe(true);});
  const [row]=await owner.db.select().from(s.company).where(eq(s.company.id,other.id));expect(row.parentCompanyId).toBeNull();
 });
 it.each(['reset','reopen'] as const)('%s preserves unchanged retired-group membership across caller timezones without changing the caller date or zone',async(kind)=>{
  const group=randomUUID();await owner.db.execute(sql`insert into public.access_group(id,tenant_id,name,retired_at) values(${group}::uuid,${b.tenantId}::uuid,'Fictional retired membership','2020-01-01T01:02:03Z'::timestamptz)`);await owner.db.execute(sql`insert into public.access_membership(tenant_id,group_id,user_id) values(${b.tenantId}::uuid,${group}::uuid,${b.adminUserId}::uuid)`);
  const otherUser=await createAppUser(b.tenantId,null,'employee'),review=await prepareKind(kind);
  await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('TimeZone','UTC',true)`);const current=await accessConfigurationStore.loadCurrent(tx,ctx);if(kind==='reset')await completeReset(tx,review);else await completeReopen(tx,review);await tx.execute(sql`select set_config('TimeZone','Pacific/Kiritimati',true)`);const [before]=await tx.execute<{zone:string;day:string}>(sql`select current_setting('TimeZone') as zone,current_date::text as day`);await commitAccess(tx,current,{kind:'setOverride',userId:otherUser,capabilityId:'access.configure',companyId:null,effect:'deny'});await tx.execute(sql`set constraints all immediate`);const [after]=await tx.execute<{zone:string;day:string}>(sql`select current_setting('TimeZone') as zone,current_date::text as day`);expect(after).toEqual(before);expect(after.zone).toBe('Pacific/Kiritimati');});
  const [row]=await owner.db.execute<{state:string;retired:boolean}>(sql`select r.state,(g.retired_at is not null) as retired from app.assistant_own_leave_review r cross join public.access_group g where r.id=${review.actionId}::uuid and g.id=${group}::uuid`);expect(row).toEqual({state:'completed',retired:true});
 });

 it.each(['reset','reopen'] as const)('%s refuses an actual self role revocation after forced IMMEDIATE',async(kind)=>{
  // A second real administrator prevents the independent last-admin rule from making this vacuous.
  await createAppUser(b.tenantId,null,'hr_admin');const [role]=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,b.adminUserId));expect(role.role).toBe('hr_admin');
  const review=await prepareKind(kind),before=await state();let failure:unknown;
  try{await withTenant(ctx,async tx=>{if(kind==='reset')await completeReset(tx,review);else await completeReopen(tx,review);await tx.execute(sql`set constraints all immediate`);const removed=await tx.delete(s.roleAssignment).where(eq(s.roleAssignment.id,role.id)).returning({id:s.roleAssignment.id});expect(removed).toEqual([{id:role.id}]);});}catch(e){failure=e;}
  expect(code(failure)).toBe('42501');expect(errorMessages(failure)).toContain('Payroll completion actor authority changed');expect(await state()).toEqual(before);
 });
 it('permits a later independent self role revoke through the real role table with another administrator retained',async()=>{
  await createAppUser(b.tenantId,null,'hr_admin');const [role]=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,b.adminUserId));
  const review=await prepareReset();await withTenant(ctx,tx=>completeReset(tx,review));await withTenant(ctx,async tx=>{const rows=await tx.delete(s.roleAssignment).where(eq(s.roleAssignment.id,role.id)).returning({id:s.roleAssignment.id});expect(rows).toEqual([{id:role.id}]);});expect(await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.id,role.id))).toHaveLength(0);
 });
 it('permits an unrelated actor role edit in the same completed transaction',async()=>{
  const user=await createAppUser(b.tenantId,null,'employee'),[role]=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user)),review=await prepareReset();
  await withTenant(ctx,async tx=>{await completeReset(tx,review);await tx.execute(sql`set constraints all immediate`);const removed=await tx.delete(s.roleAssignment).where(eq(s.roleAssignment.id,role.id)).returning({id:s.roleAssignment.id});expect(removed).toHaveLength(1);});expect(await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.id,role.id))).toHaveLength(0);
 });
 it('refuses an actual canonical Access policy change for the completing actor after forced IMMEDIATE',async()=>{
  await createAppUser(b.tenantId,null,'hr_admin');const review=await prepareReset(),before=await state();let failure:unknown;
  try{await withTenant(ctx,async tx=>{const current=await accessConfigurationStore.loadCurrent(tx,ctx);await completeReset(tx,review);await tx.execute(sql`set constraints all immediate`);await commitAccess(tx,current,{kind:'setOverride',userId:b.adminUserId,capabilityId:'access.configure',companyId:null,effect:'deny'});});}catch(e){failure=e;}
  expect(code(failure)).toBe('42501');expect(errorMessages(failure)).toContain('Payroll completion actor authority changed');expect(await state()).toEqual(before);
 });
 it('permits the same actual canonical actor policy change in a later independent transaction',async()=>{
  await createAppUser(b.tenantId,null,'hr_admin');const review=await prepareReset();await withTenant(ctx,tx=>completeReset(tx,review));await withTenant(ctx,async tx=>{const current=await accessConfigurationStore.loadCurrent(tx,ctx);await commitAccess(tx,current,{kind:'setOverride',userId:b.adminUserId,capabilityId:'access.configure',companyId:null,effect:'deny'});});
  const [row]=await owner.db.execute<{effect:string}>(sql`select effect from public.access_user_override where tenant_id=${b.tenantId}::uuid and user_id=${b.adminUserId}::uuid and capability_id='access.configure' and retired_at is null`);expect(row.effect).toBe('deny');
 });
 it('permits unrelated user policy and revision bookkeeping through the canonical Access owner in the same root',async()=>{
  const user=await createAppUser(b.tenantId,null,'employee'),review=await prepareReset();await withTenant(ctx,async tx=>{const current=await accessConfigurationStore.loadCurrent(tx,ctx);await completeReset(tx,review);await tx.execute(sql`set constraints all immediate`);await commitAccess(tx,current,{kind:'setOverride',userId:user,capabilityId:'access.configure',companyId:null,effect:'deny'});});
  const [row]=await owner.db.execute<{effect:string}>(sql`select effect from public.access_user_override where tenant_id=${b.tenantId}::uuid and user_id=${user}::uuid and retired_at is null`);expect(row.effect).toBe('deny');
 });
 it.each(['assistant_own_leave_reviews_expire','assistant_own_leave_reviews_expire_own'] as const)('%s expires genuine aged reopening bodies atomically, with the shared limit and other kind preserved',async(api)=>{
  const reset=await prepareReset(),reopen=await prepareKind('reopen');
  // Age genuine encrypted reviews while preserving expires_at>created_at and the real source IDs.
  await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=created_at-interval '30 minutes',expires_at=expires_at-interval '30 minutes' where id=${reopen.actionId}::uuid`);
  await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=created_at-interval '20 minutes',expires_at=expires_at-interval '20 minutes' where id=${reset.actionId}::uuid`);
  const read=async(id:string)=>{const [row]=await owner.db.execute<{state:string;root:unknown;body:number}>(sql`select r.state,r.payroll_completion_root as root,(select count(*)::integer from app.assistant_own_leave_review_content c where c.action_id=r.id) as body from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;};
  expect(await read(reopen.actionId)).toMatchObject({state:'awaiting_confirmation',body:1});expect((await read(reopen.actionId)).root).not.toBeNull();
  await withTenant(ctx,async tx=>{const [row]=await tx.execute<{count:number}>(sql`select ${sql.raw('app.'+api)}(1) as count`);expect(row.count).toBe(1);});
  expect(await read(reopen.actionId)).toEqual({state:'expired',root:null,body:0});expect(await read(reset.actionId)).toEqual({state:'awaiting_confirmation',root:null,body:1});
  await withTenant(ctx,async tx=>{const [row]=await tx.execute<{count:number}>(sql`select ${sql.raw('app.'+api)}(1) as count`);expect(row.count).toBe(1);});expect(await read(reset.actionId)).toEqual({state:'expired',root:null,body:0});
 });

 it.each(['reset','reopen'] as const)('%s refuses a silent AFTER completed-ledger source mutation',async(kind)=>{await check(kind,'ledger');});
 it.each(['reset','reopen'] as const)('%s refuses a silent AFTER body-delete source mutation',async(kind)=>{await check(kind,'body');});
 it.each(['reset','reopen'] as const)('%s retains guards after forced IMMEDIATE then a later write',async(kind)=>{
  const review=await prepareKind(kind),before=await state();let failure:unknown;
  try{await withTenant(ctx,async tx=>{if(kind==='reset')await completeReset(tx,review);else await completeReopen(tx,review);await tx.execute(sql`set constraints all immediate`);await tx.update(s.payrollInput).set({overtimeAmount:'1.00'}).where(eq(s.payrollInput.batchId,batchId));});}catch(e){failure=e;}
  expect(code(failure)).toBe('42501');expect(await state()).toEqual(before);
 });
 it('permits genuine later independent native input and regeneration after a committed reset',async()=>{
  const review=await prepareReset();await withTenant(ctx,tx=>completeReset(tx,review));await setPayrollInput(ctx,{batchId,employmentId,overtimeAmount:1});await generatePayslips(ctx,{batchId});const [row]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));expect(row.status).toBe('processed');expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId))).length).toBeGreaterThan(0);expect((await reopenPayrollResetReview(ctx,review.actionId)).kind).toBe('completed');
 });
 it('permits genuine later independent native close after a committed reopening',async()=>{
  const review=await prepareKind('reopen');await withTenant(ctx,tx=>completeReopen(tx,review));await closeBatch(ctx,{batchId});const [row]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));expect(row.status).toBe('closed');
 });

 it.each(['person_id','payroll_reset_event_id','payroll_reset_proof','expires_at','payroll_completion_root'] as const)('keeps completed %s anchored in a later independent transaction',async(column)=>{
  const review=await prepareReset();await withTenant(ctx,tx=>completeReset(tx,review));const before=await state();let failure:unknown;
  try{if(column==='expires_at')await owner.db.execute(sql`update app.assistant_own_leave_review set expires_at=expires_at+interval '1 minute' where id=${review.actionId}::uuid`);else if(column==='person_id'||column==='payroll_reset_event_id')await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=${randomUUID()}::uuid where id=${review.actionId}::uuid`);else await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=NULL where id=${review.actionId}::uuid`);}catch(e){failure=e;}
  expect(code(failure)).toBe('42501');expect(await state()).toEqual(before);
 });
 it('rejects a late BEFORE trigger clearing the seal after deferred constraints were forced IMMEDIATE',async()=>{
  const review=await prepareReset(),before=await state();await owner.db.execute(sql`create function app.zz_fictional_payroll_seal_clear() returns trigger language plpgsql as $$begin if OLD.state='completed' then NEW.payroll_completion_root:=NULL;end if;return NEW;end$$`);await owner.db.execute(sql`create trigger zz_fictional_payroll_seal_clear before update on app.assistant_own_leave_review for each row execute function app.zz_fictional_payroll_seal_clear()`);
  try{let failure:unknown;try{await withTenant(ctx,async tx=>{await completeReset(tx,review);await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`update app.assistant_own_leave_review set state=state where id=${review.actionId}::uuid`);});}catch(e){failure=e;}expect(code(failure)).toBe('42501');expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger zz_fictional_payroll_seal_clear on app.assistant_own_leave_review`);await owner.db.execute(sql`drop function app.zz_fictional_payroll_seal_clear()`);}
 });
 it('rejects malformed private purpose JSON explicitly and accepts genuinely generated pending and completed shapes',async()=>{
  const review=await prepareKind('reopen');const [pending]=await owner.db.execute<{root:unknown}>(sql`select payroll_completion_root root from app.assistant_own_leave_review where id=${review.actionId}::uuid`);expect(pending.root).not.toBeNull();
  for(const root of [{},{phase:null},{phase:'prepared'},{phase:'prepared',source:null},{phase:'completed'},[],{phase:'prepared',source:{rows:{},meta:{}}},{phase:'prepared',source:{rows:{},meta:{}},extra:true}]){const [shape]=await owner.db.execute<{valid:boolean}>(sql`select app._payroll_completion_shape(${JSON.stringify(root)}::jsonb,'payroll.reopen','awaiting_confirmation') as valid`);expect(shape.valid).toBe(false);}
  const [valid]=await owner.db.execute<{valid:boolean}>(sql`select app._payroll_completion_shape(${JSON.stringify(pending.root)}::jsonb,'payroll.reopen','awaiting_confirmation') as valid`);expect(valid.valid).toBe(true);
  await withTenant(ctx,tx=>completeReopen(tx,review));const [done]=await owner.db.execute<{valid:boolean;foreign:boolean}>(sql`select app._payroll_completion_shape(payroll_completion_root,action_kind,state) as valid,app._payroll_completion_shape(payroll_completion_root,'leave.apply','completed') as foreign from app.assistant_own_leave_review where id=${review.actionId}::uuid`);expect(done).toEqual({valid:true,foreign:false});
 });
 it('allows only canonical later erasure to scrub private root relevance while preserving original receipt anchors',async()=>{
  const review=await prepareReset();await withTenant(ctx,tx=>completeReset(tx,review));const anchor=async()=>Array.from(await owner.db.execute(sql`select to_jsonb(r)-'payroll_completion_root' as row from app.assistant_own_leave_review r where id=${review.actionId}::uuid`)),before=await anchor();
  await erasePersonPii(ctx,{subjectEmploymentId:employmentId,scope:'contact',requestRef:'FICTIONAL-ROOT-SEAL-ERASURE',reason:'Fictional canonical root erasure'});const [root]=await owner.db.execute<{value:unknown}>(sql`select payroll_completion_root value from app.assistant_own_leave_review where id=${review.actionId}::uuid`);expect(root.value).toBeNull();expect(await anchor()).toEqual(before);
 });
 it('refuses a replaced employment privacy target even when the actual capture count is unchanged',async()=>{
  const review=await prepareReset(),before=await state();await owner.db.execute(sql`create function app.zz_fictional_payroll_capture_replace() returns trigger language plpgsql as $$begin if NEW.kind='employment' then update app.native_outcome_source_target set target_id=gen_random_uuid() where capture_id=NEW.capture_id and kind=NEW.kind and target_id=NEW.target_id;end if;return NULL;end$$`);await owner.db.execute(sql`create trigger zz_fictional_payroll_capture_replace after insert on app.native_outcome_source_target for each row execute function app.zz_fictional_payroll_capture_replace()`);
  try{let failure:unknown;try{await withTenant(ctx,tx=>completeReset(tx,review));}catch(e){failure=e;}expect(code(failure)).toBe('42501');expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger zz_fictional_payroll_capture_replace on app.native_outcome_source_target`);await owner.db.execute(sql`drop function app.zz_fictional_payroll_capture_replace()`);}
 });

 it('refuses an actual reopening native-event trigger changing unchanged financial input before terminal sealing',async()=>{
  const review=await prepareKind('reopen'),before=await state();await owner.db.execute(sql`create function app.zz_fictional_reopen_native_effect() returns trigger language plpgsql as $$begin if NEW.event_type='payroll-batch.unlocked' then update public.payroll_input set overtime_amount='1.00' where batch_id=NEW.aggregate_id;end if;return NULL;end$$`);await owner.db.execute(sql`create trigger zz_fictional_reopen_native_effect after insert on public.domain_event for each row execute function app.zz_fictional_reopen_native_effect()`);
  try{let failure:unknown;try{await withTenant(ctx,async tx=>{
   const human={action:'payroll.reopen' as const,contractVersion:1 as const,batchId,reason,confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true},prepared=await prepareReviewedPayrollReopenSourceTx(tx,ctx,human),native=await unlockClosedBatchTx(tx,ctx,{batchId,reason});
   await captureNativeOutcomeTargetsTx(tx,ctx,{action:'payroll.reopen',sourceId:review.actionId,eventId:native.unlockedEventId,targets:[...prepared.erasurePersonIds.map(id=>({kind:'person' as const,id})),...prepared.erasureEmploymentIds.map(id=>({kind:'employment' as const,id}))]});
   const [input]=await tx.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,batchId));expect(input.overtimeAmount).toBe('1.00');await tx.execute(sql`select app.assistant_payroll_reopen_review_complete(${review.actionId}::uuid,${review.reviewedDigest},${native.unlockedEventId}::uuid)`);
  });}catch(e){failure=e;}expect(code(failure)).toBe('42501');expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger zz_fictional_reopen_native_effect on public.domain_event`);await owner.db.execute(sql`drop function app.zz_fictional_reopen_native_effect()`);}
 });

});
async function prepareKind(kind:'reset'|'reopen'){
 if(kind==='reset')return prepareReset();await closeBatch(ctx,{batchId});const r=await preparePayrollReopenReview(ctx,{action:'payroll.reopen',contractVersion:1,batchId,reason,confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true});if(r.kind!=='prepared')throw Error('Expected genuine reopening custody');return r.review;
}

async function check(kind:'reset'|'reopen',phase:'ledger'|'body'){
 // Fixture source row is native-owned input; no app-calculated financial value is admitted.
 const originalInputs=await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,batchId));expect(originalInputs).toHaveLength(1);expect(originalInputs[0].overtimeAmount).toBe('0.00');
 let review:{actionId:string;reviewedDigest:string};
 if(kind==='reset')review=await prepareReset();else{await closeBatch(ctx,{batchId});const r=await preparePayrollReopenReview(ctx,{action:'payroll.reopen',contractVersion:1,batchId,reason,confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true});if(r.kind!=='prepared')throw Error('Expected genuine reopening custody');review=r.review;}
 const before=await state();
 await owner.db.execute(sql.raw(`create function app.zz_fictional_payroll_late_effect() returns trigger language plpgsql as $$declare target uuid;begin
 ${phase==='ledger'?"IF NEW.state='completed' AND OLD.state='awaiting_confirmation' THEN target:=CASE WHEN NEW.action_kind='payroll.reset' THEN NEW.payroll_reset_batch_id WHEN NEW.action_kind='payroll.reopen' THEN NEW.payroll_reopen_batch_id ELSE NULL END;END IF;":"SELECT CASE WHEN action_kind='payroll.reset' THEN payroll_reset_batch_id WHEN action_kind='payroll.reopen' THEN payroll_reopen_batch_id END INTO target FROM app.assistant_own_leave_review WHERE id=OLD.action_id AND state='completed';"}
 IF target IS NOT NULL THEN UPDATE public.payroll_input SET overtime_amount='1.00' WHERE batch_id=target;END IF;RETURN NULL;end$$`));
 await owner.db.execute(sql.raw(`create trigger zz_fictional_payroll_late_effect after ${phase==='ledger'?'update on app.assistant_own_leave_review':'delete on app.assistant_own_leave_review_content'} for each row execute function app.zz_fictional_payroll_late_effect()`));
 try{let failure:unknown;try{await withTenant(ctx,tx=>kind==='reset'?completeReset(tx,review,true):completeReopen(tx,review,true));}catch(error){failure=error;}expect(failure,'Transaction must refuse the late mutation, not merely return historical receipt').toBeDefined();expect(code(failure)).toBe('42501');expect(await state()).toEqual(before);}
 finally{await owner.db.execute(sql.raw(`drop trigger zz_fictional_payroll_late_effect on ${phase==='ledger'?'app.assistant_own_leave_review':'app.assistant_own_leave_review_content'}`));await owner.db.execute(sql`drop function app.zz_fictional_payroll_late_effect()`);}
}

function errorMessages(error:unknown):string[]{const messages:string[]=[];let next=error;for(let n=0;n<8&&next&&typeof next==='object';n++){const row=next as {message?:string;cause?:unknown};if(row.message)messages.push(row.message);next=row.cause;}return messages;}
async function commitAccess(tx:Tx,current:Awaited<ReturnType<typeof accessConfigurationStore.loadCurrent>>,command:unknown){const [row]=await tx.execute<{committed:boolean}>(sql`select app.access_configuration_commit(${current.snapshot.revision}::uuid,${current.scopeFingerprint},${JSON.stringify(command)}::jsonb,${randomUUID()}::uuid) as committed`);expect(row.committed).toBe(true);}

async function scopedTree(){
 const globalUser=await createAppUser(b.tenantId,null,'hr_admin');const [top]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional scope A'}).returning({id:s.company.id});const [middle]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional intermediate B',parentCompanyId:top.id}).returning({id:s.company.id});const [outside]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional outside root'}).returning({id:s.company.id});
 await owner.db.update(s.company).set({parentCompanyId:middle.id}).where(eq(s.company.id,b.companyId));await owner.db.update(s.roleAssignment).set({companyId:top.id}).where(eq(s.roleAssignment.appUserId,b.adminUserId));ctx={...ctx,grants:[{role:'hr_admin',companyId:top.id}]};return{globalUser,top:top.id,middle:middle.id,outside:outside.id};
}
async function useActualGlobalActor(tx:Tx,user:string){await tx.execute(sql`select set_config('app.user_id',${user},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`);const [row]=await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`);expect(row.current).toBe(true);}
async function restoreScopedActor(tx:Tx){await tx.execute(sql`select set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(ctx.grants)},true)`);}

function nativeState(snapshot:Awaited<ReturnType<typeof state>>){const {reviews:_reviews,bodies:_bodies,...native}=snapshot;return native;}
