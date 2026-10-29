/** WP9 store 2: generic OWN custody, retaining the installed TOIL SQL protocol and sealed-row format.
 * Submission records the employee's request; the native owner alone calculates and grants credit. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {createGenericOwnReviewStore,type OwnReviewPersistence} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {OWN_TOIL_REPLACEMENT_ACTION as action,OwnToilReplacementHumanContent as Human} from '../../lib/assistant-actions/own-toil-replacement-contract';
import {ToilRequestReviewConfirmation,ToilRequestReviewRetirement,ToilRequestPreparedReview,ToilRequestCompletedReview,ToilRequestRetiredReview,ToilRequestReviewIndex} from '../../lib/assistant-actions/toil-request-review-contract';
import {assertOwnToilReplacementActorTx,withOwnToilReplacementIntervalTx,prepareOwnToilReplacementSourceTx,confirmOwnToilReplacementSourceTx,reconcileOwnToilReplacementSourceTx} from './own-toil-replacement-source';
export class ToilRequestReviewUnavailable extends Error{constructor(){super('That time-in-lieu review needs a little breather. Please reopen it and try again.');this.name='ToilRequestReviewUnavailable';}}
const fail=():never=>{throw new ToilRequestReviewUnavailable();};
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid(),employmentId:z.guid(),companyId:z.guid()}).strict(),intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
// Decode the existing projection strictly before adapting its names. No DB row or ciphertext is rewritten.
const Legacy=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),requestId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(r=>
 (r.metadata.state==='completed')===(r.requestId!==null&&r.eventId!==null)&&((r.requestId===null)===(r.eventId===null)));
const normalize=(value:unknown)=>{const row=Legacy.parse(value);return{metadata:row.metadata,sealed:row.sealed,subjectKind:'employment',subjectId:row.metadata.binding.employmentId,eventId:row.eventId,...(row.requestId?{nativeRequestId:row.requestId}:{})};};
const persistence:OwnReviewPersistence={
 assertActor:assertOwnToilReplacementActorTx,
 async subject(tx,id){const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_toil_request_review_subject(${id}::uuid) as subject`);const employmentId=z.guid().parse(row?.subject);return{employmentId,subjectId:employmentId};},
 async read(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_toil_request_review_read(${id}::uuid) as review`);return normalize(row?.review);},
 async prepare(tx,m,sealed){const b=m.binding;const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_toil_request_review_prepare(${m.actionId}::uuid,${b.personId}::uuid,${b.employmentId}::uuid,${b.companyId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return normalize(row?.review);},
 async complete(tx,id,expected,native){if(!native.nativeRequestId)return fail();const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_toil_request_review_complete(${id}::uuid,${expected},${native.nativeRequestId}::uuid,${native.eventId}::uuid) as review`);return normalize(row?.review);},
 async discard(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_toil_request_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async index(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_toil_request_reviews_index()`));},
};
export const toilRequestReviews=createGenericOwnReviewStore({
 action,subjectKind:'employment',subjectOf:(human:Human)=>human.employmentId,human:Human,consequence:'request_only_no_credit_grant_or_cash',persistence,
 prepared:ToilRequestPreparedReview,completed:ToilRequestCompletedReview,retired:ToilRequestRetiredReview,index:ToilRequestReviewIndex,indexKind:'toil_request_review_index',
 withSubject:(tx,ctx,id,work)=>withOwnToilReplacementIntervalTx(tx,ctx,id,(fresh,source)=>work(fresh,{...source,subjectId:source.employmentId})),
 prepare:prepareOwnToilReplacementSourceTx,
 confirm:async(tx,fresh,human,reviewedDigest)=>{const receipt=await confirmOwnToilReplacementSourceTx(tx,fresh,human,{action,contractVersion:1,reviewedDigest});return{receipt,eventId:receipt.submittedEventId,nativeRequestId:receipt.requestId};},
 reconcile:(tx,fresh,ref)=>{if(!ref.nativeRequestId)return fail();return reconcileOwnToilReplacementSourceTx(tx,fresh,{employmentId:ref.employmentId,requestId:ref.nativeRequestId,submittedEventId:ref.eventId});},unavailable:fail,
});
export const prepareToilRequestReview=toilRequestReviews.prepare;
export async function confirmToilRequestReview(ctx:SessionContext,input:unknown){const parsed=ToilRequestReviewConfirmation.safeParse(input);if(!parsed.success)return fail();return toilRequestReviews.confirm(ctx,parsed.data);}
export const reopenToilRequestReview=toilRequestReviews.reopen;
export async function discardToilRequestReview(ctx:SessionContext,input:unknown){const parsed=ToilRequestReviewRetirement.safeParse(input);if(!parsed.success)return fail();return toilRequestReviews.discard(ctx,parsed.data);}
export const listToilRequestReviews=toilRequestReviews.list;
export const readCompletedToilRequestOutcomeTx=toilRequestReviews.readCompletedOutcomeTx;
