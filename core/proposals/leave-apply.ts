/** ADR-0170 step 0b — `leave.apply` as a signed proposal object, end to end over the existing owners.
 *
 * Prepare: the existing own-leave review preparer (core/assistant-actions/own-leave-store.ts) runs the leave
 * service's own validation as the caller (actor, eligible type, deduction and balance preview, review
 * contract) and saves the review custody row. Only when it returns a prepared review is a proposal issued,
 * carrying that review's digest, expiry and route. Render: the Assistant card hint shape ({action, hints}).
 * Confirm: the existing review page (/assistant/leave, POST /api/assistant/own-leave) under the person's
 * own login; this module only turns a verified proposal into that page's own confirmation packet. Nothing
 * here writes a leave request. Not imported by the production Assistant. */
import {withTenant,type SessionContext} from '../../db/client';
import type {AssistantProposalHints} from '../../lib/ai/assistant-action-proposal-hints';
import {OWN_LEAVE_ACTION,OWN_LEAVE_CONTRACT_VERSION,OwnLeaveNomination,type OwnLeaveConfirmation} from '../../lib/assistant-actions/own-leave-contract';
import {prepareOwnLeaveReviewTx} from '../assistant-actions/own-leave-store';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {issueProposal,verifyProposal,type Proposal,type ProposalRefusal} from './proposal';

const declared=SEMANTIC_ACTIONS.find(action=>action.id===OWN_LEAVE_ACTION)!;
/** The checks the preparer runs, from the semantic model. A prepared review means every one passed. */
const passedChecks=()=>declared.checks.map(check=>({check:check.check,owner:check.owner,
 ruleVersion:check.ruleVersion===null?null:`${OWN_LEAVE_ACTION}/contract:${OWN_LEAVE_CONTRACT_VERSION}`,result:'pass' as const}));

export type LeaveApplyProposalResult=Readonly<{kind:'proposal';proposal:Proposal}>
 |Readonly<{kind:'unavailable'|'needs_selection'|'needs_employee_remark'|'use_leave_form'}>;
/** Inputs come from the person's own selection and text, never from a model or a posted session. */
export async function prepareLeaveApplyProposal(supplied:SessionContext,input:Readonly<{nomination:unknown;selection:unknown;humanText:unknown}>,locale?:string):Promise<LeaveApplyProposalResult>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 const nomination=OwnLeaveNomination.safeParse(input.nomination);
 const prepared=await withTenant(ctx,tx=>prepareOwnLeaveReviewTx(tx,ctx,input.nomination,input.selection,input.humanText,locale));
 if(prepared.kind!=='prepared')return Object.freeze({kind:prepared.kind});
 // The preparer bound the review to this person and this nominated employment; anything else is refused.
 const personId=ctx.personId;
 if(!nomination.success||!personId||prepared.review.date!==nomination.data.date)return Object.freeze({kind:'unavailable'});
 const review=prepared.review;
 return Object.freeze({kind:'proposal',proposal:issueProposal({
  what:{action:OWN_LEAVE_ACTION,contractVersion:review.contractVersion,entity:declared.entity,effect:declared.effect,
   selectors:{date:review.date,durationType:review.durationType},reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:nomination.data.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId:ctx.userId,personId},
  checks:passedChecks(),
  review:{route:declared.reviewRoute,href:`${declared.reviewRoute}?review=${review.actionId}`,reference:review.actionId},
  createdAt:review.createdAt,expiresAt:review.expiresAt})});
}

/** The current Assistant card hint shape: the typed selector the person verifies, plus where to review. */
export function leaveApplyCardHint(proposal:Proposal):Readonly<{action:typeof OWN_LEAVE_ACTION;hints:AssistantProposalHints;reviewHref:string;expiresAt:string}>{
 if(proposal.body.what.action!==OWN_LEAVE_ACTION)throw Error('Not a leave application proposal.');
 return Object.freeze({action:OWN_LEAVE_ACTION,hints:Object.freeze({date:proposal.body.what.selectors.date}),reviewHref:proposal.body.review.href,expiresAt:proposal.body.expiresAt});
}

/** Packets the existing review page posts for the verified proposal, under the caller's own login. */
export type LeaveApplyReviewPackets=Readonly<{reopen:Readonly<{operation:'reopen';actionId:string}>;confirm:Readonly<{operation:'confirm';confirmation:OwnLeaveConfirmation}>}>;
export function leaveApplyReviewPackets(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;packets:LeaveApplyReviewPackets}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'}>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review}=verified.proposal.body;
 if(what.action!==OWN_LEAVE_ACTION||what.contractVersion!==OWN_LEAVE_CONTRACT_VERSION||review.route!==declared.reviewRoute)return{ok:false,reason:'wrong_action'};
 return{ok:true,packets:Object.freeze({reopen:Object.freeze({operation:'reopen' as const,actionId:review.reference}),
  confirm:Object.freeze({operation:'confirm' as const,confirmation:Object.freeze({actionId:review.reference,contractVersion:OWN_LEAVE_CONTRACT_VERSION,reviewedDigest:what.reviewedDigest})})})};
}
