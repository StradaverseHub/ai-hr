/** ADR-0151 (amendment 2026-10-29): HR-prepared leave adjustment and assignment-only movement, as kinds of the
 * wave 1b generic assigned-review store (caller = administrator, subject = another person's employment). */
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {createGenericAssignedReviewStore} from './generic-assigned-review-store';
import {HrLeaveAdjustment,HrMovementTransfer} from '../../lib/assistant-actions/hr-prepared-contract';
import {hrPreparedUnavailable,withHrLeaveAdjustmentSubjectTx,readHrLeaveAdjustmentChoicesTx,prepareHrLeaveAdjustmentSourceTx,confirmHrLeaveAdjustmentSourceTx,reconcileHrLeaveAdjustmentSourceTx,
 withHrMovementSubjectTx,readHrMovementChoicesTx,prepareHrMovementSourceTx,confirmHrMovementSourceTx,reconcileHrMovementSourceTx} from './hr-prepared-sources';

export const leaveAdjustmentReviews=createGenericAssignedReviewStore({
 action:HrLeaveAdjustment.action,human:HrLeaveAdjustment.Human,consequence:HrLeaveAdjustment.consequence,
 prepared:HrLeaveAdjustment.Prepared,completed:HrLeaveAdjustment.Completed,retired:HrLeaveAdjustment.Retired,index:HrLeaveAdjustment.Index,indexKind:HrLeaveAdjustment.indexKind,
 withSubject:withHrLeaveAdjustmentSubjectTx,prepare:prepareHrLeaveAdjustmentSourceTx,confirm:confirmHrLeaveAdjustmentSourceTx,reconcile:reconcileHrLeaveAdjustmentSourceTx,unavailable:hrPreparedUnavailable,
});
export const movementTransferReviews=createGenericAssignedReviewStore({
 action:HrMovementTransfer.action,human:HrMovementTransfer.Human,consequence:HrMovementTransfer.consequence,
 prepared:HrMovementTransfer.Prepared,completed:HrMovementTransfer.Completed,retired:HrMovementTransfer.Retired,index:HrMovementTransfer.Index,indexKind:HrMovementTransfer.indexKind,
 withSubject:withHrMovementSubjectTx,prepare:prepareHrMovementSourceTx,confirm:confirmHrMovementSourceTx,reconcile:reconcileHrMovementSourceTx,unavailable:hrPreparedUnavailable,
});
const choices=(read:(tx:Tx,ctx:SessionContext,selection?:unknown)=>Promise<unknown>)=>async(supplied:SessionContext,selection?:unknown)=>{const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>read(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}};
export const readLeaveAdjustmentChoices=choices(readHrLeaveAdjustmentChoicesTx);
export const readMovementTransferChoices=choices(readHrMovementChoicesTx);
