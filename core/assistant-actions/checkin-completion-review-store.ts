import {withTenant,type SessionContext} from '../../db/client';
import {createPerformancePostimageReviewStore} from './performance-postimage-custody-adapter';
import {CheckInCompletion as C} from '../../lib/assistant-actions/checkin-completion-contract';
import {withCheckInCompletionSubjectTx,prepareCheckInCompletionSourceTx,confirmCheckInCompletionSourceTx,reconcileCheckInCompletionSourceTx,readCheckInCompletionChoicesTx,checkInCompletionUnavailable} from './checkin-completion-source';
export const checkInCompletionReviews=createPerformancePostimageReviewStore({action:C.action,human:C.Human,consequence:C.consequence,prepared:C.Prepared,completed:C.Completed,retired:C.Retired,index:C.Index,indexKind:C.indexKind,withSubject:withCheckInCompletionSubjectTx,prepare:prepareCheckInCompletionSourceTx,confirm:confirmCheckInCompletionSourceTx,reconcile:reconcileCheckInCompletionSourceTx,unavailable:checkInCompletionUnavailable});
export async function readCheckInCompletionChoices(ctx:SessionContext,selection?:unknown){try{return await withTenant(ctx,tx=>readCheckInCompletionChoicesTx(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}}
