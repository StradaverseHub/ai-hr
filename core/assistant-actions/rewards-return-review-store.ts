/** Annual-only encrypted custody. Exact V4 SQL cleared independently; runtime evidence remains separate. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REWARDS_RETURN_ACTION as action,RewardsReturnHuman as Human,RewardsReturnReview} from '../../lib/assistant-actions/rewards-return-contract';
import {RewardsReturnHuman as RewardsReturnReviewPrepare,RewardsReturnConfirmation as RewardsReturnReviewConfirmation,RewardsReturnRetirement as RewardsReturnReviewRetirement,RewardsReturnPrepared as RewardsReturnPreparedReview,RewardsReturnCompleted as RewardsReturnCompletedReview,RewardsReturnRetired as RewardsReturnRetiredReview,RewardsReturnIndex as RewardsReturnReviewIndex} from '../../lib/assistant-actions/rewards-return-contract';
import {withRewardsReturnBoundsTx,assertRewardsReturnActorTx,withRewardsReturnIntervalTx,prepareRewardsReturnSourceTx,confirmRewardsReturnSourceTx,reconcileRewardsReturnSourceTx,RewardsReturnStoredSnapshot,type RewardsReturnSource} from './rewards-return-source';

export class RewardsReturnReviewUnavailable extends Error{constructor(){super('That Rewards handoff needs another look. Please reopen the approved review.');this.name='RewardsReturnReviewUnavailable';}}
const fail=():never=>{throw new RewardsReturnReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),unitId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),returnedRevision:z.number().int().nonnegative().nullable(),decisionId:z.guid().nullable(),snapshot:RewardsReturnStoredSnapshot.nullable(),commitment:digest.nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null&&value.snapshot!==null)
 &&(value.metadata.state==='completed')===(value.returnedRevision!==null&&value.eventId!==null&&value.decisionId!==null&&value.commitment!==null)
 &&((value.returnedRevision===null)===(value.eventId===null))&&((value.decisionId===null)===(value.eventId===null))&&((value.commitment===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.snapshot===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
type Source=RewardsReturnSource;
async function confirmNative(tx:Tx,ctx:SessionContext,body:{content:z.infer<typeof Human>;nativeReviewedDigest:string},source:Source){if(body.content.unitId!==source.unitId)return fail();return confirmRewardsReturnSourceTx(tx,ctx,body.content,body.nativeReviewedDigest,source);}
export const rewardsReturnReviews=createGenericAssignedCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,Awaited<ReturnType<typeof prepareRewardsReturnSourceTx>>,Awaited<ReturnType<typeof confirmNative>>,
 z.infer<typeof RewardsReturnPreparedReview>,z.infer<typeof RewardsReturnCompletedReview>,z.infer<typeof RewardsReturnRetiredReview>,z.infer<typeof RewardsReturnReviewIndex>
>({
 action,tier:'approve',human:RewardsReturnReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:RewardsReturnReviewConfirmation,retirement:RewardsReturnReviewRetirement,retired:RewardsReturnRetiredReview,index:RewardsReturnReviewIndex,indexKind:'rewards_return_review_index',
 async withInterval(tx,ctx,nomination,work){return withRewardsReturnBoundsTx(tx,async()=>{let unitId:string,actor=ctx;if(nomination.human)unitId=nomination.human.unitId;else{actor=await assertRewardsReturnActorTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_rewards_return_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);unitId=z.guid().parse(row?.subject);}return withRewardsReturnIntervalTx(tx,actor,unitId,nomination.actionId??null,work);});},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,unitId:source.unitId}),
 assertSubjectBinding:(binding,source)=>{if(binding.unitId!==source.unitId||binding.companyId!==source.companyId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.unitId.toLowerCase()!==binding.unitId)return fail();},
 prepareNative:(tx,ctx,human,source)=>prepareRewardsReturnSourceTx(tx,ctx,human,source),confirmNative,
 pending:(row,body,current)=>RewardsReturnPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId||row.returnedRevision===null||!row.decisionId)return fail();const receipt=await reconcileRewardsReturnSourceTx(tx,ctx,row.metadata.actionId);if(receipt.returnedRevision!==row.returnedRevision||receipt.eventId!==row.eventId||receipt.decisionId!==row.decisionId||receipt.unitId!==row.metadata.binding.unitId)return fail();return RewardsReturnCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.proof.eventId,assertCompletion:(row,native)=>{if(row.eventId!==native.proof.eventId||row.returnedRevision!==native.proof.returnedRevision||row.decisionId!==native.proof.decisionId)return fail();},targets:(_source,native)=>native.targets,
 async prepareRow(tx,m,sealed,_source,_human,current){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_return_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.unitId}::uuid,${b.companyId}::uuid,${current.nativeDecisionDigest},${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_rewards_return_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_return_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_return_review_complete(${id}::uuid,${expected},${native.reason},${JSON.stringify(native.proof)}::jsonb) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_return_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_rewards_return_reviews_index()`));},unavailable:fail,
});
export const prepareRewardsReturnReview=rewardsReturnReviews.prepare;
export const confirmRewardsReturnReview=rewardsReturnReviews.confirm;
export const reopenRewardsReturnReview=rewardsReturnReviews.reopen;
export const discardRewardsReturnReview=rewardsReturnReviews.discard;
export const listRewardsReturnReviews=rewardsReturnReviews.list;
export const readCompletedRewardsReturnOutcomeTx=rewardsReturnReviews.readCompletedOutcomeTx;
