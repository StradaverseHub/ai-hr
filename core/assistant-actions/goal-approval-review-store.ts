import {withTenant,type SessionContext} from '../../db/client';
import {createPerformancePostimageReviewStore} from './performance-postimage-custody-adapter';
import {GoalApproval as C} from '../../lib/assistant-actions/goal-approval-contract';
import {withGoalApprovalSubjectTx,prepareGoalApprovalSourceTx,confirmGoalApprovalSourceTx,reconcileGoalApprovalSourceTx,readGoalApprovalChoicesTx,goalApprovalUnavailable} from './goal-approval-source';
export const goalApprovalReviews=createPerformancePostimageReviewStore({action:C.action,human:C.Human,consequence:C.consequence,prepared:C.Prepared,completed:C.Completed,retired:C.Retired,index:C.Index,indexKind:C.indexKind,withSubject:withGoalApprovalSubjectTx,prepare:prepareGoalApprovalSourceTx,confirm:confirmGoalApprovalSourceTx,reconcile:reconcileGoalApprovalSourceTx,unavailable:goalApprovalUnavailable});
export async function readGoalApprovalChoices(ctx:SessionContext,selection?:unknown){try{return await withTenant(ctx,tx=>readGoalApprovalChoicesTx(tx,ctx,selection));}catch{return{kind:'unavailable' as const};}}
