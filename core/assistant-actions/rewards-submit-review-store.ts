/** Unmounted annual-submit custody; exact private SQL review/allocation is pending. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REWARDS_SUBMIT_ACTION as action,RewardsSubmitHuman as Human,RewardsSubmitReview} from '../../lib/assistant-actions/rewards-submit-contract';
import {RewardsSubmitHuman as RewardsSubmitReviewPrepare,RewardsSubmitConfirmation as RewardsSubmitReviewConfirmation,RewardsSubmitRetirement as RewardsSubmitReviewRetirement,RewardsSubmitPrepared as RewardsSubmitPreparedReview,RewardsSubmitCompleted as RewardsSubmitCompletedReview,RewardsSubmitRetired as RewardsSubmitRetiredReview,RewardsSubmitIndex as RewardsSubmitReviewIndex} from '../../lib/assistant-actions/rewards-submit-contract';
import {withRewardsSubmitBoundsTx,assertRewardsSubmitActorTx,withRewardsSubmitIntervalTx,prepareRewardsSubmitSourceTx,confirmRewardsSubmitSourceTx,reconcileRewardsSubmitSourceTx,RewardsSubmitStoredSnapshot,type RewardsSubmitSource} from './rewards-submit-source';

export class RewardsSubmitReviewUnavailable extends Error{constructor(){super('That Rewards handoff needs another look. Please reopen the approved review.');this.name='RewardsSubmitReviewUnavailable';}}
const fail=():never=>{throw new RewardsSubmitReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),unitId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),submittedRevision:z.number().int().nonnegative().nullable(),decisionId:z.guid().nullable(),snapshot:RewardsSubmitStoredSnapshot.nullable(),commitment:digest.nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null&&value.snapshot!==null)
 &&(value.metadata.state==='completed')===(value.submittedRevision!==null&&value.eventId!==null&&value.decisionId!==null&&value.commitment!==null)
 &&((value.submittedRevision===null)===(value.eventId===null))&&((value.decisionId===null)===(value.eventId===null))&&((value.commitment===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.snapshot===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
type Source=RewardsSubmitSource;
async function confirmNative(tx:Tx,ctx:SessionContext,body:{content:z.infer<typeof Human>;nativeReviewedDigest:string},source:Source){if(body.content.unitId!==source.unitId)return fail();return confirmRewardsSubmitSourceTx(tx,ctx,body.content,body.nativeReviewedDigest,source);}
export const rewardsSubmitReviews=createGenericAssignedCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,Awaited<ReturnType<typeof prepareRewardsSubmitSourceTx>>,Awaited<ReturnType<typeof confirmNative>>,
 z.infer<typeof RewardsSubmitPreparedReview>,z.infer<typeof RewardsSubmitCompletedReview>,z.infer<typeof RewardsSubmitRetiredReview>,z.infer<typeof RewardsSubmitReviewIndex>
>({
 action,tier:'approve',human:RewardsSubmitReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:RewardsSubmitReviewConfirmation,retirement:RewardsSubmitReviewRetirement,retired:RewardsSubmitRetiredReview,index:RewardsSubmitReviewIndex,indexKind:'rewards_submit_review_index',
 async withInterval(tx,ctx,nomination,work){return withRewardsSubmitBoundsTx(tx,async()=>{let unitId:string,actor=ctx;if(nomination.human)unitId=nomination.human.unitId;else{actor=await assertRewardsSubmitActorTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_rewards_submit_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);unitId=z.guid().parse(row?.subject);}return withRewardsSubmitIntervalTx(tx,actor,unitId,nomination.actionId??null,work);});},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,unitId:source.unitId}),
 assertSubjectBinding:(binding,source)=>{if(binding.unitId!==source.unitId||binding.companyId!==source.companyId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.unitId.toLowerCase()!==binding.unitId)return fail();},
 prepareNative:(tx,ctx,human,source)=>prepareRewardsSubmitSourceTx(tx,ctx,human,source),confirmNative,
 pending:(row,body,current)=>RewardsSubmitPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId||row.submittedRevision===null||!row.decisionId)return fail();const receipt=await reconcileRewardsSubmitSourceTx(tx,ctx,row.metadata.actionId);if(receipt.submittedRevision!==row.submittedRevision||receipt.eventId!==row.eventId||receipt.decisionId!==row.decisionId||receipt.unitId!==row.metadata.binding.unitId)return fail();return RewardsSubmitCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.proof.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.proof.eventId||row.submittedRevision!==native.proof.submittedRevision||row.decisionId!==native.proof.decisionId)return fail();},targets:(_source,native)=>native.targets,
 async prepareRow(tx,m,sealed,_source,_human,current){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_submit_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.unitId}::uuid,${b.companyId}::uuid,${current.nativeDecisionDigest},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_rewards_submit_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_submit_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_submit_review_complete(${id}::uuid,${expected},${native.reason},${JSON.stringify(native.proof)}::jsonb) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_submit_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_rewards_submit_reviews_index()`));},unavailable:fail,
});
export const prepareRewardsSubmitReview=rewardsSubmitReviews.prepare;
export const confirmRewardsSubmitReview=rewardsSubmitReviews.confirm;
export const reopenRewardsSubmitReview=rewardsSubmitReviews.reopen;
export const discardRewardsSubmitReview=rewardsSubmitReviews.discard;
export const listRewardsSubmitReviews=rewardsSubmitReviews.list;
export const readCompletedRewardsSubmitOutcomeTx=rewardsSubmitReviews.readCompletedOutcomeTx;
