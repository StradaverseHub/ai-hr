/** WP9: generic OWN lifecycle acknowledgement custody, preserving native unlinked prehire identity. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {PrivateReviewNonce} from './private-review-commitment';
import {OwnLeaveSealedReview} from './own-leave-content';
import {OWN_LIFECYCLE_ACKNOWLEDGEMENT_ACTION as action,OwnLifecycleAcknowledgementHumanContent as Human} from '../../lib/assistant-actions/own-lifecycle-acknowledgement-contract';
import {LifecycleAckReviewConfirmation,LifecycleAckReviewRetirement,LifecycleAckPreparedReview,LifecycleAckCompletedReview,LifecycleAckRetiredReview,LifecycleAckReviewIndex} from '../../lib/assistant-actions/lifecycle-ack-review-contract';
import {prepareOwnLifecycleAcknowledgementSourceTx,confirmOwnLifecycleAcknowledgementSourceTx,reconcileOwnLifecycleAcknowledgementSourceTx,withOwnLifecycleAcknowledgementIntervalTx,assertOwnLifecycleAcknowledgementActorTx} from './own-lifecycle-acknowledgement-source';
export class LifecycleAckReviewUnavailable extends Error{constructor(){super('Your equipment review is playing hide-and-seek. Please reopen it and try again.');this.name='LifecycleAckReviewUnavailable';}}
const fail=():never=>{throw new LifecycleAckReviewUnavailable();},digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.guid().nullable(),companyId:z.guid().nullable(),caseId:z.guid(),casePersonId:z.guid().nullable()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.eventId!==null)
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
type Source={caseId:string;caseNumber:string;casePersonId:string|null;employmentId:string|null;companyId:string|null};
// This extra field is part of the old commitment and ciphertext, not optional new metadata.
const Body=z.object({reviewNonce:PrivateReviewNonce,content:Human,caseNumber:z.string().min(1).max(100),nativeReviewedDigest:digest}).strict();
export const lifecycleAckReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof Human>,z.infer<typeof Binding>,Stored,Source,
 Awaited<ReturnType<typeof prepareOwnLifecycleAcknowledgementSourceTx>>,Awaited<ReturnType<typeof confirmOwnLifecycleAcknowledgementSourceTx>>,
 z.infer<typeof LifecycleAckPreparedReview>,z.infer<typeof LifecycleAckCompletedReview>,z.infer<typeof LifecycleAckRetiredReview>,z.infer<typeof LifecycleAckReviewIndex>
>({
 action,tier:'confirm',human:Human,metadata:Metadata,stored:Stored,
 confirmation:LifecycleAckReviewConfirmation,retirement:LifecycleAckReviewRetirement,retired:LifecycleAckRetiredReview,index:LifecycleAckReviewIndex,indexKind:'lifecycle_ack_review_index',
 body:{read:value=>Body.parse(value),write:body=>Body.parse(body),create:(native,reviewNonce)=>Body.parse({reviewNonce,content:native.content,caseNumber:native.caseNumber,nativeReviewedDigest:native.reviewedDigest}),assertCurrent:(body,current)=>{if(Body.parse(body).caseNumber!==current.caseNumber)return fail();}},
 async withInterval(tx,ctx,nomination,work){const actor=await assertOwnLifecycleAcknowledgementActorTx(tx,ctx);let caseId:string;
  if(nomination.human)caseId=nomination.human.caseId;else{const id=z.guid().parse(nomination.actionId),[row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_lifecycle_ack_review_subject(${id}::uuid) as subject`);caseId=z.guid().parse(row?.subject);}
  return withOwnLifecycleAcknowledgementIntervalTx(tx,actor,caseId,work);
 },
 binding:(ctx,source)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:source.employmentId,companyId:source.companyId,caseId:source.caseId,casePersonId:source.casePersonId}),
 assertSubjectBinding:(binding,source)=>{if(binding.caseId!==source.caseId||binding.casePersonId!==source.casePersonId||binding.employmentId!==source.employmentId||binding.companyId!==source.companyId)return fail();},
 assertHumanBinding:(binding,human)=>{if(human.caseId!==binding.caseId)return fail();},
 prepareNative:(tx,ctx,human)=>prepareOwnLifecycleAcknowledgementSourceTx(tx,ctx,human),
 confirmNative:(tx,ctx,body)=>confirmOwnLifecycleAcknowledgementSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body)=>LifecycleAckPreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,caseNumber:Body.parse(body).caseNumber,consequence:'equipment_acknowledgement_only'}),
 async completed(tx,ctx,row){if(!row.eventId)return fail();const receipt=await reconcileOwnLifecycleAcknowledgementSourceTx(tx,ctx,{caseId:row.metadata.binding.caseId,submittedEventId:row.eventId});return LifecycleAckCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.submittedEventId,
 assertCompletion:(row,native)=>{if(row.eventId!==native.submittedEventId||row.metadata.binding.caseId!==native.caseId)return fail();},
 targets:source=>[{kind:'lifecycle_case',id:source.caseId},...(source.employmentId?[{kind:'employment' as const,id:source.employmentId}]:[]),...(source.casePersonId?[{kind:'person' as const,id:source.casePersonId}]:[])],
 async prepareRow(tx,m,sealed){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_lifecycle_ack_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.caseId}::uuid,${b.casePersonId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_lifecycle_ack_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_lifecycle_ack_review_complete(${id}::uuid,${expected},${native.caseId}::uuid,${native.submittedEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_lifecycle_ack_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_lifecycle_ack_reviews_index()`));},unavailable:fail,
});
export const prepareLifecycleAckReview=lifecycleAckReviews.prepare;
export const confirmLifecycleAckReview=lifecycleAckReviews.confirm;
export const reopenLifecycleAckReview=lifecycleAckReviews.reopen;
export const discardLifecycleAckReview=lifecycleAckReviews.discard;
export const listLifecycleAckReviews=lifecycleAckReviews.list;
export const readCompletedLifecycleAckOutcomeTx=lifecycleAckReviews.readCompletedOutcomeTx;
