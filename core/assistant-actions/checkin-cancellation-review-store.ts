import {withTenant,type SessionContext} from '../../db/client';
import {createCheckInCancellationReviewStore} from './checkin-cancellation-custody-adapter';
import {CheckInCancellation as C} from '../../lib/assistant-actions/checkin-cancellation-contract';
import {withCheckInCancellationSubjectTx,prepareCheckInCancellationSourceTx,confirmCheckInCancellationSourceTx,reconcileCheckInCancellationSourceTx,readCheckInCancellationChoicesTx,checkInCancellationUnavailable} from './checkin-cancellation-source';
export const checkInCancellationReviews=createCheckInCancellationReviewStore({action:C.action,human:C.Human,consequence:C.consequence,prepared:C.Prepared,completed:C.Completed,retired:C.Retired,index:C.Index,indexKind:C.indexKind,withSubject:withCheckInCancellationSubjectTx,prepare:prepareCheckInCancellationSourceTx,confirm:confirmCheckInCancellationSourceTx,reconcile:reconcileCheckInCancellationSourceTx,unavailable:checkInCancellationUnavailable});
export async function readCheckInCancellationChoices(ctx:SessionContext,selection?:unknown){try{return await withTenant(ctx,tx=>readCheckInCancellationChoicesTx(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}}
