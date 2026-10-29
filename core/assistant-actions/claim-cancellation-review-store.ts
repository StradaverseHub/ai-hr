/** WP9 store 1: claims.cancel uses the existing generic OWN custody family. The action, sealed-body
 * identity, nonce commitment, SQL row format and exported transport functions remain compatible with 0670. */
import {withTenant,type SessionContext} from '../../db/client';
import {createGenericOwnReviewStore} from './generic-own-review-store';
import {OWN_CLAIM_CANCELLATION_ACTION as action,OwnClaimCancellationHumanContent,ClaimCancellationReviewConfirmation,ClaimCancellationReviewRetirement,ClaimCancellationPreparedReview,ClaimCancellationCompletedReview,ClaimCancellationRetiredReview,ClaimCancellationReviewIndex} from '../../lib/assistant-actions/own-claim-cancellation-contract';
import {withOwnClaimCancellationSubjectTx,prepareOwnClaimCancellationSourceTx,confirmOwnClaimCancellationSourceTx,reconcileOwnClaimCancellationSourceTx,readOwnClaimCancellationChoicesTx} from './own-claim-cancellation-source';
export class ClaimCancellationReviewUnavailable extends Error{constructor(){super('That claim cancellation review needs a fresh look. Please reopen it and try again.');this.name='ClaimCancellationReviewUnavailable';}}
const fail=():never=>{throw new ClaimCancellationReviewUnavailable();};
export const claimCancellationReviews=createGenericOwnReviewStore({
 action,subjectKind:'claim_request',subjectOf:(human:OwnClaimCancellationHumanContent)=>human.claimId,
 human:OwnClaimCancellationHumanContent,consequence:'pending_claim_cancelled_no_payment',
 prepared:ClaimCancellationPreparedReview,completed:ClaimCancellationCompletedReview,retired:ClaimCancellationRetiredReview,index:ClaimCancellationReviewIndex,indexKind:'claim_cancellation_review_index',
 withSubject:(tx,ctx,id,work)=>withOwnClaimCancellationSubjectTx(tx,ctx,id,(fresh,own)=>work(fresh,{subjectId:own.claimId,employmentId:own.employmentId,companyId:own.companyId})),
 prepare:prepareOwnClaimCancellationSourceTx,
 confirm:async(tx,fresh,human,digest)=>{const receipt=await confirmOwnClaimCancellationSourceTx(tx,fresh,human,digest);return{receipt,eventId:receipt.cancelledEventId};},
 reconcile:(tx,fresh,reference)=>reconcileOwnClaimCancellationSourceTx(tx,fresh,{claimId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId}),
 unavailable:fail,
});
export async function readClaimCancellationChoices(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>readOwnClaimCancellationChoicesTx(tx,ctx));}catch{return{kind:'unavailable' as const};}}
export const prepareClaimCancellationReview=claimCancellationReviews.prepare;
export async function confirmClaimCancellationReview(ctx:SessionContext,input:unknown){const parsed=ClaimCancellationReviewConfirmation.safeParse(input);if(!parsed.success)return fail();return claimCancellationReviews.confirm(ctx,parsed.data);}
export const reopenClaimCancellationReview=claimCancellationReviews.reopen;
export async function discardClaimCancellationReview(ctx:SessionContext,input:unknown){const parsed=ClaimCancellationReviewRetirement.safeParse(input);if(!parsed.success)return fail();return claimCancellationReviews.discard(ctx,parsed.data);}
export const listClaimCancellationReviews=claimCancellationReviews.list;
export const readCompletedClaimCancellationOutcomeTx=claimCancellationReviews.readCompletedOutcomeTx;
