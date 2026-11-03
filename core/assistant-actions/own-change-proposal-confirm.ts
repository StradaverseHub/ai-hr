/** AI v2 W2 — Confirm and Edit for an own claim or own profile change prepared in chat (core/proposals/claim-submit.ts,
 * claim-cancel.ts, profile-change.ts).
 *
 * Confirm acts only on the person's explicit Confirm (`confirm: true`), under their own login:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person), and name one of the
 *     three actions with its own review route, so a tampered, expired, foreign or retargeted proposal is refused before
 *     any read;
 *  2. the sealed review the preparer saved is confirmed through its existing custody, which re-runs every owner check in
 *     its own top-level transaction (the actor and Assistant grant, the module, the AI and action pauses, the own
 *     subject, the reviewed digest), and then the owning service:
 *     - claims.submit: the draft is saved, then submitted through the claims submission review, where the claims service
 *       takes its limit lock and checks the receipt window, caps, annual, monthly, lifetime and per-block limits and
 *       custom fields. A refusal there submits nothing and keeps the saved draft for the person to fix on Claims, the
 *       same as the claim form's own save-then-submit; the claims service's own sentence is returned, never a figure
 *       computed here. A claim type that needs a receipt is saved as a draft only;
 *     - claims.cancel: the native cancellation (pending claims only);
 *     - ess.profile.request: the ADR-0159 profile change request, which HR then approves (bank details included).
 *  A repeated Confirm replays the completed review instead of acting twice.
 * Edit reopens the same sealed review as the caller (validated server-side again) and returns the existing form or
 * review page for it. Errors are bounded to a refusal code; no source detail, private value or SQL escapes. No model. */
import {withTenant,type SessionContext} from '../../db/client';
import {ClaimError,prepareOwnClaimSubmissionReviewTx} from '../../packs/claims/service';
import {OWN_CLAIM_DRAFT_ACTION} from '../../lib/assistant-actions/own-claim-contract';
import {OWN_CLAIM_SUBMISSION_ACTION} from '../../lib/assistant-actions/own-claim-submission-contract';
import {OWN_CLAIM_CANCELLATION_ACTION} from '../../lib/assistant-actions/own-claim-cancellation-contract';
import {OWN_PROFILE_CHANGE_ACTION} from '../../lib/assistant-actions/own-profile-change-contract';
import {withAgentActionPauseScope} from '../agent-action-pause-scope';
import {assertAgentActionUnpausedTx} from '../ai-governance';
import {verifyProposal,type Proposal,type ProposalRefusal} from '../proposals/proposal';
import {confirmClaimModuleActionReview,confirmClaimSubmissionModuleActionReview,confirmProfileModuleActionReview,prepareClaimSubmissionModuleActionReview,
 reopenClaimModuleActionReview,reopenProfileModuleActionReview} from './module-action-review-store';
import {confirmClaimCancellationReview,reopenClaimCancellationReview} from './claim-cancellation-review-store';

/** The actions this owner confirms, each with the only review route its proposals may name. */
export const OWN_CHANGE_ROUTES=Object.freeze({[OWN_CLAIM_SUBMISSION_ACTION]:'/assistant/claims',[OWN_CLAIM_CANCELLATION_ACTION]:'/assistant/claims',[OWN_PROFILE_CHANGE_ACTION]:'/assistant/profile'} as const);
export type OwnChangeAction=keyof typeof OWN_CHANGE_ROUTES;
export type OwnChangeRefusal=ProposalRefusal|'wrong_action'|'not_confirmed'|'unavailable'|'retired'|'service_refused';
export type OwnChangeConfirmResult=Readonly<{kind:'submitted';action:typeof OWN_CLAIM_SUBMISSION_ACTION;claimId:string}>
 /** A claim type that needs a receipt: the draft is saved; the person adds the receipt and submits on Claims. */
 |Readonly<{kind:'draft_saved';action:typeof OWN_CLAIM_SUBMISSION_ACTION;href:string}>
 |Readonly<{kind:'cancelled';action:typeof OWN_CLAIM_CANCELLATION_ACTION;claimId:string}>
 /** Sent to HR; nothing changes until HR approves it. */
 |Readonly<{kind:'requested';action:typeof OWN_PROFILE_CHANGE_ACTION;requestId:string}>
 /** `message` is the owning service's own refusal sentence; `href` is where the person can fix it. */
 |Readonly<{kind:'refused';reason:OwnChangeRefusal;message?:string;href?:string}>;
export type OwnChangeEditResult=Readonly<{ok:true;href:string}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'|'unavailable'}>;

const refused=(reason:OwnChangeRefusal,extra:Readonly<{message?:string;href?:string}>={}):OwnChangeConfirmResult=>Object.freeze({kind:'refused' as const,reason,...extra});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const isOwnChange=(action:string):action is OwnChangeAction=>Object.hasOwn(OWN_CHANGE_ROUTES,action);

/** Integrity, freshness and authority for THIS caller, then the action and its own review route. */
function verified(ctx:SessionContext,value:unknown,now:Date):Readonly<{ok:true;proposal:Proposal;action:OwnChangeAction}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'}>{
 const result=verifyProposal(value,ctx,now);
 if(!result.ok)return result;
 const {what,review,forWhom}=result.proposal.body;
 if(!isOwnChange(what.action)||what.contractVersion!==1||review.route!==OWN_CHANGE_ROUTES[what.action]||forWhom.subject!=='own_employment')return{ok:false,reason:'wrong_action'};
 return{ok:true,proposal:result.proposal,action:what.action};
}

export async function confirmOwnChangeProposal(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown}>,now:Date=new Date()):Promise<OwnChangeConfirmResult>{
 const ctx=capture(supplied);
 // Only the person's explicit Confirm acts; anything else (absent, "true", 1) is not a confirmation.
 if(input.confirm!==true)return refused('not_confirmed');
 try{
  const checked=verified(ctx,input.proposal,now);
  if(!checked.ok)return refused(checked.reason);
  if(checked.action===OWN_CLAIM_SUBMISSION_ACTION)return await confirmClaim(ctx,checked.proposal);
  if(checked.action===OWN_CLAIM_CANCELLATION_ACTION)return await confirmCancellation(ctx,checked.proposal);
  return await confirmProfileChange(ctx,checked.proposal);
 }catch{return refused('unavailable');}
}

async function confirmClaim(ctx:SessionContext,proposal:Proposal):Promise<OwnChangeConfirmResult>{
 const {what,review,facts,forWhom}=proposal.body;
 // A card that submits: a paused claims.submit saves no draft either.
 await withTenant(ctx,tx=>assertAgentActionUnpausedTx(tx,OWN_CLAIM_SUBMISSION_ACTION));
 const draft=await withAgentActionPauseScope(OWN_CLAIM_DRAFT_ACTION,()=>confirmClaimModuleActionReview(ctx,{action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,actionId:review.reference,reviewedDigest:what.reviewedDigest}));
 if(draft.kind!=='completed')return refused('retired');
 const {draftId,employmentId,currentStatus}=draft.receipt;
 if(employmentId!==forWhom.subjectId)return refused('unavailable');
 // A repeated Confirm: the draft this card saved was already submitted (or decided) through the claims service.
 if(currentStatus==='pending'||currentStatus==='approved'||currentStatus==='paid')return Object.freeze({kind:'submitted' as const,action:OWN_CLAIM_SUBMISSION_ACTION,claimId:draftId});
 if(currentStatus!=='draft')return refused('retired');
 const fix=`/claims?draft=${draftId}`;
 if(facts?.outcome==='claim_draft_receipt_needed')return Object.freeze({kind:'draft_saved' as const,action:OWN_CLAIM_SUBMISSION_ACTION,href:fix});
 let submission:Awaited<ReturnType<typeof prepareClaimSubmissionModuleActionReview>>;
 try{submission=await withAgentActionPauseScope(OWN_CLAIM_SUBMISSION_ACTION,()=>prepareClaimSubmissionModuleActionReview(ctx,{action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,employmentId,draftId,receiptIds:[],submitForApproval:true}));}
 catch{const message=await claimsServiceRefusal(ctx,employmentId,draftId);return message?refused('service_refused',{message,href:fix}):refused('unavailable',{href:fix});}
 const done=await withAgentActionPauseScope(OWN_CLAIM_SUBMISSION_ACTION,()=>confirmClaimSubmissionModuleActionReview(ctx,{action:OWN_CLAIM_SUBMISSION_ACTION,contractVersion:1,actionId:submission.review.actionId,reviewedDigest:submission.review.reviewedDigest}));
 return done.kind==='completed'?Object.freeze({kind:'submitted' as const,action:OWN_CLAIM_SUBMISSION_ACTION,claimId:done.receipt.receipt.claimId}):refused('retired',{href:fix});
}
/** The claims service's own refusal sentence for this draft (over a limit, outside the receipt window, ...), read by
 * running its own submission checks once more in a savepoint that is always rolled back. Never a figure computed here. */
async function claimsServiceRefusal(ctx:SessionContext,employmentId:string,draftId:string):Promise<string|undefined>{
 try{return await withTenant(ctx,async tx=>{
  try{await tx.transaction(async inner=>{await prepareOwnClaimSubmissionReviewTx(inner,ctx,{employmentId,draftId,receiptIds:[]});throw new RolledBack();});}
  catch(error){return error instanceof ClaimError?error.message.slice(0,400):undefined;}
  return undefined;
 });}catch{return undefined;}
}
class RolledBack extends Error{constructor(){super('Rolled back.');this.name='RolledBack';}}

async function confirmCancellation(ctx:SessionContext,proposal:Proposal):Promise<OwnChangeConfirmResult>{
 const {what,review}=proposal.body;
 const done=await withAgentActionPauseScope(OWN_CLAIM_CANCELLATION_ACTION,()=>confirmClaimCancellationReview(ctx,{action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,actionId:review.reference,reviewedDigest:what.reviewedDigest}));
 return done.kind==='completed'?Object.freeze({kind:'cancelled' as const,action:OWN_CLAIM_CANCELLATION_ACTION,claimId:done.receipt.receipt.claimId}):refused('retired');
}
async function confirmProfileChange(ctx:SessionContext,proposal:Proposal):Promise<OwnChangeConfirmResult>{
 const {what,review}=proposal.body;
 const done=await withAgentActionPauseScope(OWN_PROFILE_CHANGE_ACTION,()=>confirmProfileModuleActionReview(ctx,{action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,actionId:review.reference,reviewedDigest:what.reviewedDigest}));
 return done.kind==='completed'?Object.freeze({kind:'requested' as const,action:OWN_PROFILE_CHANGE_ACTION,requestId:done.receipt.requestId}):refused('retired');
}

/** The tab of the profile page where each change is made by hand. */
const PROFILE_TAB:Readonly<Record<string,string>>=Object.freeze({address:'profile',emergency_contact:'profile',dependant:'family',bank:'bankStatutory'});
/** Edit: the same sealed review, reopened as the caller (it re-runs the owner's checks), then the page to change it on:
 *  - a claim: the claim review page with every entry filled in, or the saved draft on Claims once confirmed;
 *  - a cancellation: its review page;
 *  - a profile change: the profile page's own tab, where the person edits and requests it themselves.
 * No value is ever put in the link: only the review handle or the draft the person already owns. */
export async function editOwnChangeProposal(supplied:SessionContext,value:unknown,now:Date=new Date()):Promise<OwnChangeEditResult>{
 const ctx=capture(supplied);
 try{
  const checked=verified(ctx,value,now);
  if(!checked.ok)return checked;
  const {review,what}=checked.proposal.body;
  if(checked.action===OWN_CLAIM_SUBMISSION_ACTION){
   const current=await reopenClaimModuleActionReview(ctx,review.reference);
   if(current.kind==='prepared')return{ok:true,href:review.href};
   if(current.kind==='completed')return{ok:true,href:current.receipt.currentStatus==='draft'?`/claims?draft=${current.receipt.draftId}`:'/claims'};
   return{ok:false,reason:'unavailable'};
  }
  if(checked.action===OWN_CLAIM_CANCELLATION_ACTION){
   const current=await reopenClaimCancellationReview(ctx,review.reference);
   return current.kind==='prepared'?{ok:true,href:review.href}:current.kind==='completed'?{ok:true,href:'/claims'}:{ok:false,reason:'unavailable'};
  }
  const current=await reopenProfileModuleActionReview(ctx,review.reference);
  if(current.kind!=='prepared'&&current.kind!=='completed')return{ok:false,reason:'unavailable'};
  const tab=PROFILE_TAB[what.selectors.change??''];
  return tab?{ok:true,href:`/me?tab=${tab}`}:{ok:false,reason:'unavailable'};
 }catch{return{ok:false,reason:'unavailable'};}
}
