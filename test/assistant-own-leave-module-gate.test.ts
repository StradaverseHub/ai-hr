/** Actual app-role native lifecycle cases, authored UNRUN. No model/provider or grant bypass.
 * These require the coordinated custody/control/native-outcome migrations in the real test harness.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,mayUseAssistant,revokeAssistant} from '../core/assistant-grant';
import {isModuleEnabled,resolveEntitlementsTx} from '../core/entitlements';
import {readOwnLeaveCandidateTx} from '../core/assistant-actions/own-leave-candidate';
import {readOwnLeaveChoicesTx} from '../core/assistant-actions/own-leave-choices';
import {prepareOwnLeaveReviewTx,reopenOwnLeaveReviewTx,confirmOwnLeaveReview,listOwnLeaveReviewsTx,
 discardOwnLeaveReviewTx,readCompletedOwnLeaveOutcomeTx} from '../core/assistant-actions/own-leave-store';
import {OwnLeaveContentUnavailable} from '../core/assistant-actions/own-leave-content';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,nomination:{action:'leave.apply';contractVersion:1;employmentId:string;leaveTypeId:string;date:string;durationType:'full_day'};
const human={reason:'Fictional leave module control',employeeRemark:'Human-selected exact text'};
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('MODULE_KILL','');vi.stubEnv('AI_CONFIG_SECRET','fictional-ownleave-module-key-never-live');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Leave Module Actor',primaryEmail:randomUUID()+'@fixture.test'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,employee.personId,'employee');await grantAssistant(adminCtx(b),{appUserId:userId});
 ctx={...await entitledCtx(b,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 nomination={action:'leave.apply',contractVersion:1,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,date:next.toISOString().slice(0,10),durationType:'full_day'};
});
const selection=()=>({employmentId:nomination.employmentId,leaveTypeId:nomination.leaveTypeId});
const prepare=()=>withTenant(ctx,tx=>prepareOwnLeaveReviewTx(tx,ctx,nomination,selection(),human,'en'));
async function prepared(){const result=await prepare();expect(result.kind).toBe('prepared');if(result.kind!=='prepared')throw Error('Fictional fixture did not prepare');return result.review;}
const confirmation=(review:Awaited<ReturnType<typeof prepared>>)=>({actionId:review.actionId,contractVersion:review.contractVersion,reviewedDigest:review.reviewedDigest});
async function state(){return{
 requests:await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.tenantId,b.tenantId)).orderBy(s.leaveRequest.id),
 ledger:await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.tenantId,b.tenantId)).orderBy(s.leaveLedger.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
 runs:await owner.db.select().from(s.aiModelRun).where(eq(s.aiModelRun.tenantId,b.tenantId)).orderBy(s.aiModelRun.id),
 reviews:await owner.db.execute(sql`select r.id,r.state,r.intent_digest,r.reviewed_digest,r.leave_request_id,r.submission_event_id,
  (select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as body_count
  from app.assistant_own_leave_review r where r.tenant_id=${b.tenantId}::uuid order by r.id`),
};}
async function killed(){vi.stubEnv('MODULE_KILL','leave');
 const proof=await withTenant(ctx,async tx=>{const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  const [principal]=await tx.execute<{role:string;matches:boolean}>(sql`select current_user as role,app.principal_snapshot_current() as matches`);
  return{principal,leave:isModuleEnabled(fresh,'leave'),assistant:await mayUseAssistant(fresh,tx)};});
 expect(proof).toEqual({principal:{role:'ai_hr_app',matches:true},leave:false,assistant:{allowed:true}});
}
describe('fresh Leave module control on own human-review lifecycle',()=>{
 it('refuses choices, candidate and prepare under a Leave-only kill despite real Assistant access, without custody or effects',async()=>{
  expect((await withTenant(ctx,tx=>readOwnLeaveChoicesTx(tx,ctx,'en'))).kind).toBe('choices');
  await killed();const before=await state();expect(before.reviews).toHaveLength(0);
  expect(await withTenant(ctx,tx=>readOwnLeaveChoicesTx(tx,ctx,'en'))).toEqual({kind:'unavailable'});
  expect(await withTenant(ctx,tx=>readOwnLeaveCandidateTx(tx,ctx,nomination,selection(),human,'en'))).toEqual({kind:'unavailable'});
  expect(await prepare()).toEqual({kind:'unavailable'});expect(await state()).toEqual(before);
  vi.stubEnv('MODULE_KILL','');expect((await prepare()).kind).toBe('prepared');
 });
 it('refuses saved pending content and confirmation while killed; same action succeeds once and reconciles after release',async()=>{
  const review=await prepared();await killed();const before=await state();
  await expect(withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId,'en'))).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
  await expect(confirmOwnLeaveReview(ctx,confirmation(review),'en')).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
  expect(await state()).toEqual(before);
  vi.stubEnv('MODULE_KILL','');const completed=await confirmOwnLeaveReview(ctx,confirmation(review),'en');expect(completed.kind).toBe('completed');
  if(completed.kind!=='completed')throw Error('Expected canonical completion');const after=await state();
  expect(after.requests).toHaveLength(1);expect(after.events.filter(row=>row.eventType==='leave-request.submitted').map(row=>row.id)).toEqual([completed.receipt.submissionEventId]);
  expect(after.requests[0].id).toBe(completed.receipt.leaveRequestId);expect(after.runs).toHaveLength(0);
  expect(await confirmOwnLeaveReview(ctx,confirmation(review),'en')).toEqual(completed);
  expect(await withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId,'en'))).toEqual(completed);expect(await state()).toEqual(after);
 });
 it('keeps USER-only metadata and discard usable while Leave is killed and Assistant grant is revoked',async()=>{
  const review=await prepared();await killed();await revokeAssistant(adminCtx(b),{appUserId:ctx.userId!});
  const before=await state(),index=await withTenant(ctx,tx=>listOwnLeaveReviewsTx(tx,ctx));
  expect(index.reviews.find(row=>row.actionId===review.actionId)?.state).toBe('awaiting_confirmation');
  expect(await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, {actionId:review.actionId,contractVersion:1}))).toEqual({kind:'retired',receipt:{actionId:review.actionId,contractVersion:1,state:'discarded'}});
  const after=await state();expect(after.requests).toEqual(before.requests);expect(after.events).toEqual(before.events);expect(after.ledger).toEqual(before.ledger);expect(after.runs).toEqual(before.runs);
  expect(after.reviews).toMatchObject([{id:review.actionId,state:'discarded',intent_digest:null,reviewed_digest:null,body_count:0}]);
  expect((await withTenant(ctx,tx=>listOwnLeaveReviewsTx(tx,ctx))).reviews.find(row=>row.actionId===review.actionId)?.state).toBe('discarded');
 });
 it('does not exempt completed canonical evidence from the current Leave module gate or repeat its effect',async()=>{
  const review=await prepared(),completed=await confirmOwnLeaveReview(ctx,confirmation(review),'en');expect(completed.kind).toBe('completed');
  const evidence=await withTenant(ctx,tx=>readCompletedOwnLeaveOutcomeTx(tx,ctx,review.actionId));expect(evidence.completion).toEqual(completed);
  await killed();const before=await state();
  await expect(withTenant(ctx,tx=>readCompletedOwnLeaveOutcomeTx(tx,ctx,review.actionId))).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
  await expect(withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId,'en'))).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
  await expect(confirmOwnLeaveReview(ctx,confirmation(review),'en')).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
  expect((await withTenant(ctx,tx=>listOwnLeaveReviewsTx(tx,ctx))).reviews.find(row=>row.actionId===review.actionId)?.state).toBe('completed');expect(await state()).toEqual(before);
  vi.stubEnv('MODULE_KILL','');expect(await withTenant(ctx,tx=>readCompletedOwnLeaveOutcomeTx(tx,ctx,review.actionId))).toEqual(evidence);expect(await state()).toEqual(before);
 });
});
