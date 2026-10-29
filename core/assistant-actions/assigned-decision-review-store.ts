/** ADR-0151 wave 1b: assigned claim, attendance and replacement-leave decisions, as three kinds of the
 * generic assigned-review store. */
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {createGenericAssignedReviewStore} from './generic-assigned-review-store';
import {AssignedClaimDecision,AssignedAttendanceDecision,AssignedToilDecision} from '../../lib/assistant-actions/assigned-decision-contract';
import {assignedDecisionUnavailable,withAssignedClaimSubjectTx,readAssignedClaimChoicesTx,prepareAssignedClaimSourceTx,confirmAssignedClaimSourceTx,reconcileAssignedClaimSourceTx,
 withAssignedAttendanceSubjectTx,readAssignedAttendanceChoicesTx,prepareAssignedAttendanceSourceTx,confirmAssignedAttendanceSourceTx,reconcileAssignedAttendanceSourceTx,
 withAssignedToilSubjectTx,readAssignedToilChoicesTx,prepareAssignedToilSourceTx,confirmAssignedToilSourceTx,reconcileAssignedToilSourceTx} from './assigned-decision-sources';

const claimDecisionCustody=createGenericAssignedReviewStore({
 action:AssignedClaimDecision.action,human:AssignedClaimDecision.Human,consequence:AssignedClaimDecision.consequence,
 prepared:AssignedClaimDecision.Prepared,completed:AssignedClaimDecision.Completed,retired:AssignedClaimDecision.Retired,index:AssignedClaimDecision.Index,indexKind:AssignedClaimDecision.indexKind,
 withSubject:withAssignedClaimSubjectTx,prepare:prepareAssignedClaimSourceTx,confirm:confirmAssignedClaimSourceTx,reconcile:reconcileAssignedClaimSourceTx,unavailable:assignedDecisionUnavailable,
});
/** Apply the new input requirement only at preparation. Existing sealed bodies keep their
 * original digest and content and continue through the unchanged reopen/confirm custody. */
export const claimDecisionReviews=Object.freeze({...claimDecisionCustody,
 async prepare(ctx:SessionContext,input:unknown){
  const human=AssignedClaimDecision.Human.parse(input);
  if(human.decision==='rejected'?!human.note?.trim():human.note!==undefined)throw assignedDecisionUnavailable();
  return claimDecisionCustody.prepare(ctx,human);
 },
});
export const attendanceDecisionReviews=createGenericAssignedReviewStore({
 action:AssignedAttendanceDecision.action,human:AssignedAttendanceDecision.Human,consequence:AssignedAttendanceDecision.consequence,
 prepared:AssignedAttendanceDecision.Prepared,completed:AssignedAttendanceDecision.Completed,retired:AssignedAttendanceDecision.Retired,index:AssignedAttendanceDecision.Index,indexKind:AssignedAttendanceDecision.indexKind,
 withSubject:withAssignedAttendanceSubjectTx,prepare:prepareAssignedAttendanceSourceTx,confirm:confirmAssignedAttendanceSourceTx,reconcile:reconcileAssignedAttendanceSourceTx,unavailable:assignedDecisionUnavailable,
});
export const toilDecisionReviews=createGenericAssignedReviewStore({
 action:AssignedToilDecision.action,human:AssignedToilDecision.Human,consequence:AssignedToilDecision.consequence,
 prepared:AssignedToilDecision.Prepared,completed:AssignedToilDecision.Completed,retired:AssignedToilDecision.Retired,index:AssignedToilDecision.Index,indexKind:AssignedToilDecision.indexKind,
 withSubject:withAssignedToilSubjectTx,prepare:prepareAssignedToilSourceTx,confirm:confirmAssignedToilSourceTx,reconcile:reconcileAssignedToilSourceTx,unavailable:assignedDecisionUnavailable,
});
const choices=(read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>async(supplied:SessionContext)=>{const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,tx=>read(tx,ctx));}catch{return{kind:'unavailable' as const};}};
export const readClaimDecisionChoices=choices(readAssignedClaimChoicesTx);
export const readAttendanceDecisionChoices=choices(readAssignedAttendanceChoicesTx);
export const readToilDecisionChoices=choices(readAssignedToilChoicesTx);
