import {withTenant,type SessionContext} from '../../db/client';
import {createCheckInSchedulingReviewStore} from './checkin-scheduling-custody-adapter';
import {CheckInScheduling as C} from '../../lib/assistant-actions/checkin-scheduling-contract';
import {withCheckInSchedulingSubjectTx,prepareCheckInSchedulingSourceTx,confirmCheckInSchedulingSourceTx,reconcileCheckInSchedulingSourceTx,readCheckInSchedulingChoicesTx,checkInSchedulingUnavailable} from './checkin-scheduling-source';
export const checkInSchedulingReviews=createCheckInSchedulingReviewStore({action:C.action,human:C.Human,consequence:C.consequence,prepared:C.Prepared,completed:C.Completed,retired:C.Retired,index:C.Index,indexKind:C.indexKind,withSubject:withCheckInSchedulingSubjectTx,prepare:prepareCheckInSchedulingSourceTx,confirm:confirmCheckInSchedulingSourceTx,reconcile:reconcileCheckInSchedulingSourceTx,unavailable:checkInSchedulingUnavailable});
export async function readCheckInSchedulingChoices(ctx:SessionContext,selection?:unknown){try{return await withTenant(ctx,tx=>readCheckInSchedulingChoicesTx(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}}
