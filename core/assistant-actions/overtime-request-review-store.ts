/** ADR-0151 wave 1b: own overtime request, as one kind of the generic own-review store. */
import {withTenant,type SessionContext} from '../../db/client';
import {createGenericOwnReviewStore} from './generic-own-review-store';
import {OWN_OVERTIME_REQUEST_ACTION,OwnOvertimeHumanContent,OvertimeRequestPreparedReview,OvertimeRequestCompletedReview,OvertimeRequestRetiredReview,OvertimeRequestReviewIndex} from '../../lib/assistant-actions/own-overtime-request-contract';
import {ownOvertimeRequestUnavailable,withOwnOvertimeSubjectTx,readOwnOvertimeChoicesTx,prepareOwnOvertimeSourceTx,confirmOwnOvertimeSourceTx,reconcileOwnOvertimeSourceTx} from './own-overtime-request-source';

export const overtimeRequestReviews=createGenericOwnReviewStore({
 action:OWN_OVERTIME_REQUEST_ACTION,subjectKind:'employment',subjectOf:human=>human.employmentId,
 human:OwnOvertimeHumanContent,consequence:'overtime_requested_not_approved',
 prepared:OvertimeRequestPreparedReview,completed:OvertimeRequestCompletedReview,retired:OvertimeRequestRetiredReview,index:OvertimeRequestReviewIndex,indexKind:'overtime_request_review_index',
 withSubject:withOwnOvertimeSubjectTx,prepare:prepareOwnOvertimeSourceTx,confirm:confirmOwnOvertimeSourceTx,reconcile:reconcileOwnOvertimeSourceTx,unavailable:ownOvertimeRequestUnavailable,
});
export async function readOvertimeRequestChoices(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>readOwnOvertimeChoicesTx(tx,ctx));}catch{return{kind:'unavailable' as const};}}
