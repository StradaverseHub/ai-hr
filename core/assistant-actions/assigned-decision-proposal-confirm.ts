/** AI v2 W2 (slice 3, batch 2a) — Confirm and Edit for an assigned approver's decision card prepared in chat
 * (core/proposals/assigned-decide.ts: approvals.claim.decide and approvals.attendance.decide).
 *
 * Confirm decides only on the approver's explicit Confirm (`confirm: true`), under their own login:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person), name one of the two
 *     decisions with its own review route and an assigned request, so a tampered, expired, someone else's or retargeted
 *     card is refused before any read;
 *  2. the card's sealed review is reopened through the existing assigned-decision custody as the caller, which refuses
 *     unless the caller is still the request's assigned approver, the request is still pending and is not their own; its
 *     digest, request and decision must be exactly the card's;
 *  3. the custody's own confirm then runs the existing decision path in its own top-level transaction with all its checks:
 *     the Assistant grant and AI and per-action pauses, the module, the self-approval ban, the assignment (assertCanDecide,
 *     the frozen attendance workflow and its level), the reviewed facts unchanged, and the native service's own decision
 *     (decideClaimTx with its limit lock; decideAttendanceCorrection with its workflow level).
 * A repeated Confirm replays the recorded decision instead of deciding twice. Errors are bounded to a refusal code; no
 * source detail, private text or SQL escapes. No model call. */
import type {SessionContext} from '../../db/client';
import {withAgentActionPauseScope} from '../agent-action-pause-scope';
import {verifyProposal,type Proposal,type ProposalRefusal} from '../proposals/proposal';
import {ASSIGNED_DECIDE_FLOW,ASSIGNED_DECIDE_ROUTE,isAssignedDecideAction,type AssignedDecideAction} from '../proposals/assigned-decide';
import {ASSIGNED_CLAIM_DECISION_ACTION} from '../../lib/assistant-actions/assigned-decision-contract';
import {attendanceDecisionReviews,claimDecisionReviews} from './assigned-decision-review-store';

export type AssignedDecisionRefusal=ProposalRefusal|'wrong_action'|'not_confirmed'|'changed'|'retired'|'unavailable';
export type AssignedDecisionConfirmResult=Readonly<{kind:'decided';action:AssignedDecideAction;decision:'approved'|'rejected';
 /** 'final' when this decision settled the request; 'level' when a later approver still decides. */recorded:'final'|'level'}>
 |Readonly<{kind:'refused';reason:AssignedDecisionRefusal}>;
export type AssignedDecisionEditResult=Readonly<{ok:true;href:string}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'|'unavailable'}>;

const refused=(reason:AssignedDecisionRefusal):AssignedDecisionConfirmResult=>Object.freeze({kind:'refused' as const,reason});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
type Receipt=Readonly<{decision:'approved'|'rejected';recorded:'final'|'level';subjectId:string}>;
const decided=(action:AssignedDecideAction,receipt:Receipt):AssignedDecisionConfirmResult=>Object.freeze({kind:'decided' as const,action,decision:receipt.decision,recorded:receipt.recorded});

/** Integrity, freshness and authority for THIS caller, then the action, its own review route and its decision. */
function verified(ctx:SessionContext,value:unknown,now:Date):Readonly<{ok:true;proposal:Proposal;action:AssignedDecideAction;decision:'approved'|'rejected'}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'}>{
 const result=verifyProposal(value,ctx,now);
 if(!result.ok)return result;
 const {what,review,forWhom,facts}=result.proposal.body,decision=facts?.decision;
 if(!isAssignedDecideAction(what.action)||what.contractVersion!==1||what.effect!=='decide'||review.route!==ASSIGNED_DECIDE_ROUTE||forWhom.subject!=='assigned_request'
  ||(decision!=='approved'&&decision!=='rejected')||what.selectors.decision!==decision
  ||review.href!==`${ASSIGNED_DECIDE_ROUTE}?flow=${ASSIGNED_DECIDE_FLOW[what.action]}&review=${review.reference}`)return{ok:false,reason:'wrong_action'};
 return{ok:true,proposal:result.proposal,action:what.action,decision};
}

export async function confirmAssignedDecisionProposal(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown}>,now:Date=new Date()):Promise<AssignedDecisionConfirmResult>{
 const ctx=capture(supplied);
 // Only the approver's explicit Confirm decides; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 let checked:ReturnType<typeof verified>;
 // Proposals fail closed without their configured secret (ProposalUnavailable): nothing is decided.
 try{checked=verified(ctx,input.proposal,now);}catch{return refused('unavailable');}
 if(!checked.ok)return refused(checked.reason);
 const {action,decision}=checked,{what,review,forWhom}=checked.proposal.body;
 const store=action===ASSIGNED_CLAIM_DECISION_ACTION?claimDecisionReviews:attendanceDecisionReviews;
 try{
  // Each custody command owns its top-level transaction: never wrapped in another one here.
  return await withAgentActionPauseScope(action,async()=>{
   const held=await store.reopen(ctx,review.reference);
   // Decided already (a second press, or a lost reply): the same outcome, never a second decision.
   if(held.kind==='completed'){const receipt=held.receipt.receipt;return receipt.subjectId===forWhom.subjectId&&receipt.decision===decision?decided(action,receipt):refused('changed');}
   if(held.kind!=='prepared')return refused('retired');
   const sealed=held.review;
   if(sealed.reviewedDigest!==what.reviewedDigest||sealed.content.subjectId!==forWhom.subjectId||sealed.content.decision!==decision)return refused('changed');
   const done=await store.confirm(ctx,{actionId:review.reference,reviewedDigest:what.reviewedDigest});
   if(done.kind!=='completed')return refused('retired');
   const receipt=done.receipt.receipt;
   return receipt.subjectId===forWhom.subjectId&&receipt.decision===decision?decided(action,receipt):refused('unavailable');
  });
 }catch{return refused('unavailable');}
}

/** Edit: the existing approvals review page on the card's own review, for a card that verifies for this caller. The
 * page reopens it as the caller and checks everything again; the approver changes or confirms the decision there. */
export function editAssignedDecisionProposal(supplied:SessionContext,proposal:unknown,now:Date=new Date()):AssignedDecisionEditResult{
 try{
  const checked=verified(capture(supplied),proposal,now);
  return checked.ok?Object.freeze({ok:true as const,href:checked.proposal.body.review.href}):Object.freeze({ok:false as const,reason:checked.reason});
 }catch{return Object.freeze({ok:false as const,reason:'unavailable' as const});}
}

/** AI v2 W2 slice 3 (review): the applicant's name on an approver's decision card, read when the card is drawn. The card
 * must verify for THIS caller and its sealed review must reopen through the custody as the caller, which admits only
 * the request's current assigned approver; the name is the one the review holds for them. It is never put in the
 * proposal's facts, and nothing here reaches the model: the chat command calls it only to render the card. Null when
 * the card does not verify, the review is not open for the caller, or anything fails. Never throws. */
export async function assignedDecisionApplicantName(supplied:SessionContext,proposal:unknown,now:Date=new Date()):Promise<string|null>{
 const ctx=capture(supplied);
 try{
  const checked=verified(ctx,proposal,now);
  if(!checked.ok)return null;
  const {review,forWhom}=checked.proposal.body;
  const store=checked.action===ASSIGNED_CLAIM_DECISION_ACTION?claimDecisionReviews:attendanceDecisionReviews;
  const held=await store.reopen(ctx,review.reference);
  if(held.kind!=='prepared'||held.review.content.subjectId!==forWhom.subjectId)return null;
  const name=held.review.review.employeeName.trim();
  return name?name:null;
 }catch{return null;}
}
