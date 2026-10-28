/** ADR-0151 wave 1: own pending leave cancellation and edit, as two kinds of the generic own-review store. */
import {withTenant,type SessionContext} from '../../db/client';
import {createGenericOwnReviewStore} from './generic-own-review-store';
import {OWN_LEAVE_CANCELLATION_ACTION,OWN_LEAVE_EDIT_ACTION,OwnLeaveCancellationHumanContent,OwnLeaveEditHumanContent,LeaveCancellationPreparedReview,LeaveCancellationCompletedReview,LeaveCancellationRetiredReview,LeaveCancellationReviewIndex,LeaveEditPreparedReview,LeaveEditCompletedReview,LeaveEditRetiredReview,LeaveEditReviewIndex} from '../../lib/assistant-actions/own-leave-change-contract';
import {ownLeaveChangeUnavailable,withOwnLeaveChangeSubjectTx,readOwnLeaveChangeChoicesTx,prepareOwnLeaveCancellationSourceTx,confirmOwnLeaveCancellationSourceTx,reconcileOwnLeaveCancellationSourceTx,prepareOwnLeaveEditSourceTx,confirmOwnLeaveEditSourceTx,reconcileOwnLeaveEditSourceTx} from './own-leave-change-source';

export const leaveCancellationReviews=createGenericOwnReviewStore({
 action:OWN_LEAVE_CANCELLATION_ACTION,subjectKind:'leave_request',subjectOf:human=>human.leaveRequestId,
 human:OwnLeaveCancellationHumanContent,consequence:'pending_leave_withdrawn',
 prepared:LeaveCancellationPreparedReview,completed:LeaveCancellationCompletedReview,retired:LeaveCancellationRetiredReview,index:LeaveCancellationReviewIndex,indexKind:'leave_cancellation_review_index',
 withSubject:withOwnLeaveChangeSubjectTx,prepare:prepareOwnLeaveCancellationSourceTx,confirm:confirmOwnLeaveCancellationSourceTx,reconcile:reconcileOwnLeaveCancellationSourceTx,unavailable:ownLeaveChangeUnavailable,
});
export const leaveEditReviews=createGenericOwnReviewStore({
 action:OWN_LEAVE_EDIT_ACTION,subjectKind:'leave_request',subjectOf:human=>human.leaveRequestId,
 human:OwnLeaveEditHumanContent,consequence:'pending_leave_edited_still_pending',
 prepared:LeaveEditPreparedReview,completed:LeaveEditCompletedReview,retired:LeaveEditRetiredReview,index:LeaveEditReviewIndex,indexKind:'leave_edit_review_index',
 withSubject:withOwnLeaveChangeSubjectTx,prepare:prepareOwnLeaveEditSourceTx,confirm:confirmOwnLeaveEditSourceTx,reconcile:reconcileOwnLeaveEditSourceTx,unavailable:ownLeaveChangeUnavailable,
});
export async function readLeaveChangeChoices(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>readOwnLeaveChangeChoicesTx(tx,ctx));}catch{return{kind:'unavailable' as const};}}
