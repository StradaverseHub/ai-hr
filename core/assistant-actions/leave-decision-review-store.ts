/** WP9: assigned Leave custody shares crypto/lifecycle while native Leave owns decisions. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx} from '../../db/client';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_LEAVE_DECISION_ACTION as action,ReviewedLeaveDecisionHumanContent as Human,ReviewedLeaveDecisionPreparedSource} from '../../lib/assistant-actions/reviewed-leave-decision-contract';
import {LeaveDecisionReviewPrepare,LeaveDecisionReviewConfirmation,LeaveDecisionReviewRetirement,LeaveDecisionPreparedReview,LeaveDecisionCompletedReview,LeaveDecisionRetiredReview,LeaveDecisionReviewIndex} from '../../lib/assistant-actions/leave-decision-review-contract';
import {assertReviewedLeaveDecisionActorTx,withReviewedLeaveDecisionIntervalTx,prepareReviewedLeaveDecisionSourceTx,confirmReviewedLeaveDecisionSourceTx,reconcileReviewedLeaveDecisionSourceTx} from './reviewed-leave-decision-source';
export class LeaveDecisionReviewUnavailable extends Error{constructor(){super('That assigned leave task needs another look. Please reopen your review.');this.name='LeaveDecisionReviewUnavailable';}}
const fail=():never=>{throw new LeaveDecisionReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid(),companyId:z.guid(),subjectPersonId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),leaveRequestId:z.guid(),stepId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;

type Source={employmentId:string;companyId:string;subjectPersonId:string;leaveRequestId:string;currentStepId:string|null};
async function subject(tx:Tx,id:string){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_leave_decision_review_subject(${id}::uuid) as subject`);return z.object({leaveRequestId:z.guid(),currentStepId:z.guid().nullable(),mode:z.enum(['pending','recorded'])}).strict().parse(row?.subject);}
export const leaveDecisionReviews=createGenericAssignedCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,z.infer<typeof ReviewedLeaveDecisionPreparedSource>,Awaited<ReturnType<typeof confirmReviewedLeaveDecisionSourceTx>>,
 z.infer<typeof LeaveDecisionPreparedReview>,z.infer<typeof LeaveDecisionCompletedReview>,z.infer<typeof LeaveDecisionRetiredReview>,z.infer<typeof LeaveDecisionReviewIndex>
>({
 action,tier:'approve',human:LeaveDecisionReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:LeaveDecisionReviewConfirmation,retirement:LeaveDecisionReviewRetirement,retired:LeaveDecisionRetiredReview,index:LeaveDecisionReviewIndex,indexKind:'leave_decision_review_index',
 async withInterval(tx,ctx,nomination,work){const actor=nomination.human?ctx:await assertReviewedLeaveDecisionActorTx(tx,ctx),ref=nomination.human?{leaveRequestId:nomination.human.leaveRequestId,currentStepId:nomination.human.currentStepId,mode:'pending' as const}:await subject(tx,z.guid().parse(nomination.actionId));return withReviewedLeaveDecisionIntervalTx(tx,actor,{leaveRequestId:ref.leaveRequestId,currentStepId:ref.currentStepId},ref.mode,(fresh,source)=>work(fresh,{...source,leaveRequestId:ref.leaveRequestId,currentStepId:ref.currentStepId}));},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:source.employmentId,companyId:source.companyId,subjectPersonId:source.subjectPersonId}),
 assertSubjectBinding:(binding,source)=>{if(binding.employmentId!==source.employmentId||binding.companyId!==source.companyId||binding.subjectPersonId!==source.subjectPersonId)return fail();},
 assertStoredSubject:(row,source)=>{if(row.leaveRequestId!==source.leaveRequestId||row.stepId!==source.currentStepId)return fail();},
 assertHumanBinding:()=>{},
 prepareNative:(tx,ctx,human)=>prepareReviewedLeaveDecisionSourceTx(tx,ctx,human),
 confirmNative:(tx,ctx,body,source)=>{if(body.content.leaveRequestId!==source.leaveRequestId||body.content.currentStepId!==source.currentStepId)return fail();return confirmReviewedLeaveDecisionSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});},
 pending:(row,body,current)=>{if(row.leaveRequestId!==body.content.leaveRequestId||row.stepId!==body.content.currentStepId)return fail();return LeaveDecisionPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review,consequence:'assigned_decision_request_may_remain_pending'});},
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await reconcileReviewedLeaveDecisionSourceTx(tx,ctx,{leaveRequestId:row.leaveRequestId,decisionEventId:row.eventId,decisionStepId:row.stepId});return LeaveDecisionCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.decisionEventId,
 assertCompletion:(row,native)=>{if(row.leaveRequestId!==native.leaveRequestId||row.stepId!==native.decisionStepId||row.eventId!==native.decisionEventId)return fail();},
 targets:source=>[{kind:'employment',id:source.employmentId},{kind:'person',id:source.subjectPersonId}],
 async prepareRow(tx,m,sealed,_source,human){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_leave_decision_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${b.subjectPersonId}::uuid,${human.leaveRequestId}::uuid,${human.currentStepId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_leave_decision_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_leave_decision_review_complete(${id}::uuid,${expected},${native.decisionEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_leave_decision_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_leave_decision_reviews_index()`));},unavailable:fail,
});
export const prepareLeaveDecisionReview=leaveDecisionReviews.prepare;
export const confirmLeaveDecisionReview=leaveDecisionReviews.confirm;
export const reopenLeaveDecisionReview=leaveDecisionReviews.reopen;
export const discardLeaveDecisionReview=leaveDecisionReviews.discard;
export const listLeaveDecisionReviews=leaveDecisionReviews.list;
export const readCompletedLeaveDecisionOutcomeTx=leaveDecisionReviews.readCompletedOutcomeTx;
