/** Authored UNRUN: source-only standard-cycle acknowledgement. Ratings below are explicit fictional
 * human fixture decisions to reach the native released state, never generated ratings or AI truth. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createCycle,openCycle,submitSelfReview,submitManagerReview,releaseCycle,closeReview,acknowledgeReview} from '../packs/performance/service';
import {prepareOwnReviewAcknowledgementTx,confirmOwnReviewAcknowledgementTx,reopenOwnReviewAcknowledgementEventTx,OwnReviewAcknowledgementRefusal} from '../core/assistant-actions/own-review-acknowledgement-source';
import {OwnReviewAcknowledgementIntent} from '../lib/assistant-actions/own-review-acknowledgement-contract';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'performance','active');await setModule(base.tenantId,'assistant','active');});
async function fixture(released=true){
 const admin=adminCtx(base),hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}),manager=await hire('Fictional Manager'),employee=await hire('Fictional Review Owner');
 const managerId=await createAppUser(base.tenantId,manager.personId,'manager'),userId=await createAppUser(base.tenantId,employee.personId,'employee');
 await setReportingLine(admin,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});await grantAssistant(admin,{appUserId:userId});await grantAssistant(admin,{appUserId:managerId});
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)},managerCtx:SessionContext={tenantId:base.tenantId,userId:managerId,personId:manager.personId,roles:['manager'],entitlements:harnessSnapshot(base.tenantId)};
 const {cycleId}=await createCycle(admin,{name:'Fictional Standard Review',companyId:base.companyId,periodStart:'2026-01-01',periodEnd:'2026-12-31',assessmentWorkflow:false});await openCycle(admin,{cycleId});
 const [review]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,employee.employmentId)));
 await submitSelfReview(ctx,{reviewId:review.id,selfRating:4});await submitManagerReview(managerCtx,{reviewId:review.id,managerRating:4,overallRating:4});if(released)await releaseCycle(admin,{cycleId});
 return {ctx,managerCtx,admin,cycleId,employmentId:employee.employmentId,intent:{version:1 as const,reviewId:review.id,acknowledge:true as const}};
}
const prepare=(a:Awaited<ReturnType<typeof fixture>>)=>withTenant(a.ctx,tx=>prepareOwnReviewAcknowledgementTx(tx,a.ctx,a.intent));
const confirm=(a:Awaited<ReturnType<typeof fixture>>,digest:string)=>withTenant(a.ctx,tx=>confirmOwnReviewAcknowledgementTx(tx,a.ctx,a.intent,digest));
async function state(a:Awaited<ReturnType<typeof fixture>>){const [review]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,a.intent.reviewId));const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,a.intent.reviewId),eq(schema.domainEvent.eventType,'performance-review.acknowledged')));return {review,events};}
describe('own released standard-review acknowledgement source',()=>{
 it('accepts only explicit acknowledgement, not rating/comment/approval or posted actor decisions',()=>{
  const input={version:1,reviewId:randomUUID(),acknowledge:true};expect(OwnReviewAcknowledgementIntent.safeParse(input).success).toBe(true);for(const field of ['rating','managerRating','comment','actor','approved'])expect(OwnReviewAcknowledgementIntent.safeParse({...input,[field]:'posted'}).success).toBe(false);expect(OwnReviewAcknowledgementIntent.safeParse({...input,acknowledge:false}).success).toBe(false);
 });
 it('uses the exact native event, preserves ratings and reconciles repeats without another effect',async()=>{
  const a=await fixture(),before=await state(a),review=await prepare(a);expect(review.engine).toBe('standard_cycle_only');expect(JSON.stringify(review)).not.toMatch(/selfRating|managerRating|overallRating|managerComments|merit|bonus/);
  const receipt=await confirm(a,review.reviewDigest),after=await state(a);expect(after.review.status).toBe('acknowledged');expect(after.events).toHaveLength(1);expect(after.events[0].id).toBe(receipt.eventId);expect(after.review.selfRating).toBe(before.review.selfRating);expect(after.review.managerRating).toBe(before.review.managerRating);expect(after.review.overallRating).toBe(before.review.overallRating);expect(receipt.meaning).toBe('acknowledged_not_rating_endorsement');
  const reference={employmentId:a.employmentId,eventId:receipt.eventId};expect(await withTenant(a.ctx,tx=>reopenOwnReviewAcknowledgementEventTx(tx,a.ctx,reference))).toEqual(receipt);expect(await withTenant(a.ctx,tx=>reopenOwnReviewAcknowledgementEventTx(tx,a.ctx,reference))).toEqual(receipt);expect(await state(a)).toEqual(after);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(after);
 });
 it('retains the ordinary UI result shape and refuses already acknowledged or unreleased state',async()=>{
  const a=await fixture(false);await expect(prepare(a)).rejects.toThrow();await releaseCycle(a.admin,{cycleId:a.cycleId});expect(await acknowledgeReview(a.ctx,{reviewId:a.intent.reviewId})).toEqual({status:'acknowledged'});await expect(prepare(a)).rejects.toThrow();expect((await state(a)).events).toHaveLength(1);
 });
 it('refuses a real intervening canonical closure and fresh Assistant/module revocation before effect',async()=>{
  const a=await fixture(),review=await prepare(a);await closeReview(a.admin,{reviewId:a.intent.reviewId,abcClass:'A'});const before=await state(a);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(before);
  const fresh=await prepare(a);await revokeAssistant(a.admin,{appUserId:a.ctx.userId!});await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();await grantAssistant(a.admin,{appUserId:a.ctx.userId!});await setModule(base.tenantId,'performance','disabled');await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(before);
 });
 it('never lets a real manager acknowledge the employee review and refuses foreign native references',async()=>{
  const a=await fixture();await expect(withTenant(a.managerCtx,tx=>prepareOwnReviewAcknowledgementTx(tx,a.managerCtx,a.intent))).rejects.toThrow();const receipt=await confirm(a,(await prepare(a)).reviewDigest);await expect(withTenant(a.managerCtx,tx=>reopenOwnReviewAcknowledgementEventTx(tx,a.managerCtx,{employmentId:a.employmentId,eventId:receipt.eventId}))).rejects.toThrow();await expect(withTenant(a.ctx,tx=>reopenOwnReviewAcknowledgementEventTx(tx,a.ctx,{employmentId:randomUUID(),eventId:receipt.eventId}))).rejects.toThrow();expect((await state(a)).events).toHaveLength(1);
 });
 it('rolls back acknowledgement and event if enclosing custody fails, then allows the original retry',async()=>{
  const a=await fixture(),review=await prepare(a),before=await state(a);await expect(withTenant(a.ctx,async tx=>{await confirmOwnReviewAcknowledgementTx(tx,a.ctx,a.intent,review.reviewDigest);throw Error('fictional custody failure');})).rejects.toThrow('fictional custody failure');expect(await state(a)).toEqual(before);await confirm(a,review.reviewDigest);expect((await state(a)).events).toHaveLength(1);
 });
 it('allows one native effect across competing direct confirmations; shared completed custody must own replay',async()=>{
  const a=await fixture(),review=await prepare(a),results=await Promise.allSettled([confirm(a,review.reviewDigest),confirm(a,review.reviewDigest)]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect((await state(a)).events).toHaveLength(1);
 });
 it('captures the human-selected review before its first await rather than retargeting retained input',async()=>{
  const a=await fixture(),original=a.intent.reviewId;const review=await withTenant(a.ctx,async tx=>{const pending=prepareOwnReviewAcknowledgementTx(tx,a.ctx,a.intent);a.intent.reviewId=randomUUID();return pending;});expect(review.reviewId).toBe(original);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();a.intent.reviewId=original;await confirm(a,review.reviewDigest);
 });
 it('refuses an actual held native review row without effects, then acknowledges after release',async()=>{
  const a=await fixture(),review=await prepare(a),before=await state(a);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;});
  const held=withTenant(a.admin,async tx=>{await tx.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(eq(schema.performanceReview.id,a.intent.reviewId)).for('update');entered();await resume;});
  try{await started;await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(before);}finally{release();await held;}
  await confirm(a,review.reviewDigest);expect((await state(a)).events).toHaveLength(1);
 });
 it('returns a typed unsupported-engine refusal for an actual stored OneHR cycle marker',async()=>{
  const a=await fixture(); // Adversarial stored engine marker, not a claimed complete OneHR journey.
  await owner.db.insert(schema.onehrCycle).values({tenantId:base.tenantId,cycleId:a.cycleId,policy:{}});let failure:unknown;try{await prepare(a);}catch(error){failure=error;}expect(failure).toBeInstanceOf(OwnReviewAcknowledgementRefusal);expect((failure as OwnReviewAcknowledgementRefusal).code).toBe('unsupported_engine');expect((await state(a)).events).toHaveLength(0);
 });
});
