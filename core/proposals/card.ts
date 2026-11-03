/** ADR-0170 step 2 — the one card renderer. Every card is rendered from a signed proposal that verified for
 * the current caller; there is no per-action card code. What the card says comes from the semantic model
 * (the action's declared purpose) and from the proposal's own closed fact vocabulary, so a new action gets a
 * card by declaring itself and issuing a proposal, never by adding a renderer.
 *
 * A card is a data object only in this step (no production UI wiring). It carries no identifier: the forWhom
 * subject is rendered as a relation to the caller, facts are labels, dates and the owners' own figures, and
 * the only handle is the review custody reference inside `review.href` (approved-leave cancellation links to
 * /leave and carries none). Labels are English product text; translation belongs to the wiring step. */
import type {SessionContext} from '../../db/client';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {verifyProposal,type Proposal,type ProposalFacts,type ProposalRefusal} from './proposal';

type FactKey=keyof ProposalFacts;
/** Display order and label of every fact; a fact not listed here cannot reach a card. */
const FACT_LABELS:Readonly<Record<FactKey,string>>=Object.freeze({
 leaveType:'Leave type',startDate:'From',endDate:'To',days:'Days',cancelDates:'Dates to give back',balanceNow:'Balance now',balanceAfter:'Balance after',
 othersAway:'Others away on these dates',decision:'Your decision',outcome:'What confirming does',
 recordedCheckIn:'Clock-in on record',recordedCheckOut:'Clock-out on record',checkIn:'Clock-in asked for',checkOut:'Clock-out asked for',
 plannedStart:'Start',plannedEnd:'End',overtimeMinutes:'Overtime minutes',creditDays:'Days credited if approved',
 claimType:'Claim type',claimItem:'Claim item',incurredOn:'Date incurred',amount:'Amount',
 profileChange:'What changes',fieldCount:'Details changed',bankName:'Bank',accountEnding:'Account ending',
 // AI v2 Phase 1 slice 3: an own letter request.
 letterType:'Letter type',
});
const OUTCOME_TEXT:Readonly<Record<NonNullable<ProposalFacts['outcome']>,string>>=Object.freeze({
 withdrawn_now:'The request is withdrawn at once.',give_back_requested:'Asks to give these dates back; the request goes through the usual approval before the days return.',
 rejection_if_confirmed:'The request is rejected.',step_decision_if_confirmed:'Your step is recorded; the request moves to the next approver.',
 approval_if_native_checks_pass:'The request is approved if the leave checks still pass.',submitted_not_approved:'The application is submitted for approval; it is not approved yet.',
 claim_submitted_if_checks_pass:'The claims service checks your limits and policy; if they pass, the claim is submitted for approval.',
 claim_draft_receipt_needed:'A draft is saved; add the receipt on Claims to submit it.',claim_cancelled_now:'The claim is cancelled at once.',
 hr_approval_required:'The change is sent to HR; nothing changes until HR approves it.',
 hr_verification_required:'The new bank details are sent to HR to verify; pay keeps going to the current account until HR approves them.',
 letter_requested_hr_prepares:'The request is sent to HR, who prepare and issue the letter.',
});
const PROFILE_CHANGE_TEXT:Readonly<Record<NonNullable<ProposalFacts['profileChange']>,string>>=Object.freeze({
 address:'Your address',emergency_contact:'Your emergency contact',dependant:'A new dependant',bank:'Your bank details',
});
const DECISION_TEXT={approved:'Approve',rejected:'Reject'} as const;
const FOR_WHOM={own_employment:'You',assigned_request:'A leave request assigned to you to decide'} as const;

export type ProposalCardFact=Readonly<{key:FactKey;label:string;value:string}>;
export type ProposalCard=Readonly<{kind:'teras.card';version:1;action:string;
 what:string;forWhom:string;facts:readonly ProposalCardFact[];
 /** The rule versions the native checks ran under, where an owner publishes one. */
 ruleVersions:readonly string[];
 /** Checks a person should look at before confirming (none in this step: a failed check issues no proposal). */
 needsReview:readonly string[];
 expiresAt:string;review:Readonly<{route:string;href:string}>}>;
/** The keys a card may have; the card tests pin these. */
export const PROPOSAL_CARD_KEYS=Object.freeze(['action','expiresAt','facts','forWhom','kind','needsReview','review','ruleVersions','version','what'] as const);

const factValue=(key:FactKey,value:NonNullable<ProposalFacts[FactKey]>):string=>{
 if(key==='outcome')return OUTCOME_TEXT[value as keyof typeof OUTCOME_TEXT];
 if(key==='decision')return DECISION_TEXT[value as keyof typeof DECISION_TEXT];
 if(key==='profileChange')return PROFILE_CHANGE_TEXT[value as keyof typeof PROFILE_CHANGE_TEXT];
 if(Array.isArray(value))return value.join(', ');
 return String(value);
};
function render(proposal:Proposal):ProposalCard{
 const body=proposal.body,declared=SEMANTIC_ACTIONS.find(action=>action.id===body.what.action);
 if(!declared)throw Error('No declared action for this proposal.');
 const facts=(Object.keys(FACT_LABELS) as FactKey[]).flatMap(key=>{const value=body.facts?.[key];return value===undefined?[]:[Object.freeze({key,label:FACT_LABELS[key],value:factValue(key,value)})];});
 return Object.freeze({kind:'teras.card' as const,version:1 as const,action:body.what.action,what:declared.purpose,forWhom:FOR_WHOM[body.forWhom.subject],
  facts:Object.freeze(facts),ruleVersions:Object.freeze([...new Set(body.checks.flatMap(check=>check.ruleVersion?[check.ruleVersion]:[]))]),
  needsReview:Object.freeze(body.checks.filter(check=>check.result==='needs_review').map(check=>check.check)),
  expiresAt:body.expiresAt,review:Object.freeze({route:body.review.route,href:body.review.href})});
}
/** Verifies the proposal for the current caller, then renders it. A proposal that does not verify has no card. */
export function renderProposalCard(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;card:ProposalCard}>|Readonly<{ok:false;reason:ProposalRefusal}>{
 const verified=verifyProposal(value,caller,now);
 return verified.ok?{ok:true,card:render(verified.proposal)}:verified;
}
