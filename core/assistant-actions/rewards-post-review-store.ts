/** WP9: Rewards post custody shares lifecycle; native Rewards owns the complete approved unit. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx,SessionContext} from '../../db/client';
import {createGenericAssignedCompatibilityStore} from './generic-assigned-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {REVIEWED_REWARDS_POST_ACTION as action,ReviewedRewardsPostHumanContent as Human,ReviewedRewardsPostPreparedSource} from '../../lib/assistant-actions/reviewed-rewards-post-contract';
import {RewardsPostReviewPrepare,RewardsPostReviewConfirmation,RewardsPostReviewRetirement,RewardsPostPreparedReview,RewardsPostCompletedReview,RewardsPostRetiredReview,RewardsPostReviewIndex} from '../../lib/assistant-actions/rewards-post-review-contract';
import {assertReviewedRewardsPostActorTx,withReviewedRewardsPostIntervalTx,prepareReviewedRewardsPostSourceTx,confirmReviewedRewardsPostSourceTx,reconcileReviewedRewardsPostSourceTx} from './reviewed-rewards-post-source';
export class RewardsPostReviewUnavailable extends Error{constructor(){super('That Rewards handoff needs another look. Please reopen the approved review.');this.name='RewardsPostReviewUnavailable';}}
const fail=():never=>{throw new RewardsPostReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.guid(),unitId:z.guid()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable(),postedRevision:z.number().int().nonnegative().nullable(),postedBatchId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.postedRevision!==null&&value.eventId!==null)
 &&((value.postedRevision===null)===(value.eventId===null))
 &&(value.metadata.state==='completed'||value.postedBatchId===null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;

type Source={unitId:string;companyId:string};
async function confirmNative(tx:Tx,ctx:SessionContext,body:{content:z.infer<typeof Human>;nativeReviewedDigest:string},source:Source){const receipt=await confirmReviewedRewardsPostSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest});if(receipt.unitId!==source.unitId||receipt.postedRevision!==body.content.revision||(receipt.postedBatchId?.toLowerCase()??null)!==(body.content.batchId?.toLowerCase()??null))return fail();return receipt;}
export const rewardsPostReviews=createGenericAssignedCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,z.infer<typeof ReviewedRewardsPostPreparedSource>,Awaited<ReturnType<typeof confirmNative>>,
 z.infer<typeof RewardsPostPreparedReview>,z.infer<typeof RewardsPostCompletedReview>,z.infer<typeof RewardsPostRetiredReview>,z.infer<typeof RewardsPostReviewIndex>
>({
 action,tier:'approve',human:RewardsPostReviewPrepare,metadata:Metadata,stored:Stored,
 confirmation:RewardsPostReviewConfirmation,retirement:RewardsPostReviewRetirement,retired:RewardsPostRetiredReview,index:RewardsPostReviewIndex,indexKind:'rewards_post_review_index',
 async withInterval(tx,ctx,nomination,work){let unitId:string,actor=ctx;if(nomination.human)unitId=nomination.human.unitId;else{actor=await assertReviewedRewardsPostActorTx(tx,ctx);const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_rewards_post_review_subject(${z.guid().parse(nomination.actionId)}::uuid) as subject`);unitId=z.guid().parse(row?.subject);}return withReviewedRewardsPostIntervalTx(tx,actor,unitId,work);},
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:source.companyId,unitId:source.unitId}),
 assertSubjectBinding:(binding,source)=>{if(binding.unitId!==source.unitId||binding.companyId!==source.companyId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.unitId.toLowerCase()!==binding.unitId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareReviewedRewardsPostSourceTx(tx,ctx,human),confirmNative,
 pending:(row,body,current)=>RewardsPostPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,review:current.review}),
 async completed(tx,ctx,row){if(!row.eventId||row.postedRevision===null)return fail();const receipt=await reconcileReviewedRewardsPostSourceTx(tx,ctx,{unitId:row.metadata.binding.unitId,postedEventId:row.eventId});if(receipt.postedRevision!==row.postedRevision||receipt.postedBatchId!==row.postedBatchId)return fail();return RewardsPostCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.postedEventId,assertCompletion:(row,native)=>{if(row.eventId!==native.postedEventId||row.postedRevision!==native.postedRevision||row.postedBatchId!==native.postedBatchId)return fail();},targets:()=>[],
 async prepareRow(tx,m,sealed){const b=m.binding,[row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_post_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.unitId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async peekRow(tx,id){const [row]=await tx.execute<{peek:unknown}>(sql`select app.assistant_rewards_post_review_peek(${id}::uuid) as peek`);return z.object({review:Stored,pendingExpired:z.boolean()}).strict().parse(row?.peek);},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_post_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_rewards_post_review_complete(${id}::uuid,${expected},${native.postedEventId}::uuid,${native.postedRevision},${native.postedBatchId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_post_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_rewards_post_reviews_index()`));},unavailable:fail,
});
export const prepareRewardsPostReview=rewardsPostReviews.prepare;
export const confirmRewardsPostReview=rewardsPostReviews.confirm;
export const reopenRewardsPostReview=rewardsPostReviews.reopen;
export const discardRewardsPostReview=rewardsPostReviews.discard;
export const listRewardsPostReviews=rewardsPostReviews.list;
export const readCompletedRewardsPostOutcomeTx=rewardsPostReviews.readCompletedOutcomeTx;
