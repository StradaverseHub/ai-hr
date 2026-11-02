/** Issue 10 — Confirm and Edit for a `leave.apply` card prepared in chat (core/proposals/leave-apply.ts).
 *
 * Confirm submits only on the person's explicit Confirm (`confirm: true`), under their own login:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person), so a tampered,
 *     expired or someone else's proposal is refused before any read;
 *  2. a review proposal (one full day) becomes the review page's own confirmation packet, and the existing review
 *     command (./own-leave-store.ts confirmOwnLeaveReview) re-runs every owner check in its own top-level transaction:
 *     the actor and Assistant grant, the leave module, the AI and action pauses, own employment, eligible type, the
 *     leave service's deduction and balance (unchanged since review), the dated calendar and company, and then
 *     requestLeave itself (overlap, notice, approval routing). Any refusal writes nothing;
 *  3. a form proposal (a range, a half day, another type) is never submitted here: the answer is the prefilled
 *     Request Leave form (Edit), where the person submits and requestLeave decides.
 * Errors are bounded to a refusal code; no source detail, private text or SQL parameter escapes. No model call. */
import {withTenant,type SessionContext} from '../../db/client';
import {withAgentActionPauseScope} from '../agent-action-pause-scope';
import {leaveApplyEditHref,leaveApplyReviewPackets,LEAVE_APPLY_FORM_ROUTE,type LeaveApplyEditResult} from '../proposals/leave-apply';
import {verifyProposal,type ProposalRefusal} from '../proposals/proposal';
import {confirmOwnLeaveReview,expireOwnLeaveReviewsForCallerTx} from './own-leave-store';

export type LeaveApplyConfirmResult=Readonly<{kind:'submitted';leaveRequestId:string}>
 /** A form proposal: the person submits on the prefilled Request Leave form. */
 |Readonly<{kind:'use_form';href:string}>
 |Readonly<{kind:'refused';reason:ProposalRefusal|'wrong_action'|'not_confirmed'|'unavailable'|'retired'}>;

const refused=(reason:Extract<LeaveApplyConfirmResult,{kind:'refused'}>['reason']):LeaveApplyConfirmResult=>Object.freeze({kind:'refused' as const,reason});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

export async function confirmLeaveApplyProposal(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown}>,locale?:string,now:Date=new Date()):Promise<LeaveApplyConfirmResult>{
 const ctx=capture(supplied);
 // Only the person's explicit Confirm submits; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 // Proposals fail closed without their configured secret (ProposalUnavailable): nothing is submitted.
 try{return await confirmVerified(ctx,input.proposal,locale,now);}catch{return refused('unavailable');}
}
async function confirmVerified(ctx:SessionContext,proposal:unknown,locale:string|undefined,now:Date):Promise<LeaveApplyConfirmResult>{
 const packets=leaveApplyReviewPackets(proposal,ctx,now);
 if(!packets.ok){
  if(packets.reason!=='wrong_action')return refused(packets.reason);
  const verified=verifyProposal(proposal,ctx,now);
  if(!verified.ok||verified.proposal.body.what.action!=='leave.apply'||verified.proposal.body.review.route!==LEAVE_APPLY_FORM_ROUTE)return refused('wrong_action');
  const edit=await leaveApplyEditHref(ctx,proposal,locale,now);
  return edit.ok?Object.freeze({kind:'use_form' as const,href:edit.href}):refused(edit.reason);
 }
 return withAgentActionPauseScope('leave.apply',async()=>{
  // Expired private review bodies are retired first, in their own transaction, as the review command does.
  await withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx));
  // The review command owns its top-level transaction: never wrapped in another one here.
  const result=await confirmOwnLeaveReview(ctx,packets.packets.confirm.confirmation,locale);
  return result.kind==='completed'?Object.freeze({kind:'submitted' as const,leaveRequestId:result.receipt.leaveRequestId}):refused('retired');
 });
}

/** Edit: the prefilled Request Leave form for any verified leave.apply card (core/proposals/leave-apply.ts). */
export async function editLeaveApplyProposal(supplied:SessionContext,proposal:unknown,locale?:string,now:Date=new Date()):Promise<LeaveApplyEditResult>{
 try{return await leaveApplyEditHref(capture(supplied),proposal,locale,now);}catch{return Object.freeze({ok:false as const,reason:'unavailable' as const});}
}
