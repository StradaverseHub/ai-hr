/** ADR-0170 step 0b — `leave.apply` as a signed proposal object, end to end over the existing owners.
 *
 * Prepare: the existing own-leave review preparer (core/assistant-actions/own-leave-store.ts) runs the leave
 * service's own validation as the caller (actor, eligible type, deduction and balance preview, review
 * contract) and saves the review custody row. Only when it returns a prepared review is a proposal issued,
 * carrying that review's digest, expiry and route. Render: the Assistant card hint shape ({action, hints}).
 * Confirm: the existing review page (/assistant/leave, POST /api/assistant/own-leave) under the person's
 * own login; this module only turns a verified proposal into that page's own confirmation packet. Nothing
 * here writes a leave request. Not imported by the production Assistant.
 *
 * From chat (issue 10, owner 3 November 2026: "answer with yes i can"): the model names a leave type, dates, a
 * duration and at most the person's own reason; prepareChatLeaveApplyProposal resolves them against the caller's
 * own apply menu and either asks for what is missing or issues one of two proposals:
 *  - review: one full day the review contract above takes (route /assistant/leave). Confirm submits it through the
 *    review command (core/assistant-actions/leave-apply-proposal-confirm.ts), which re-runs every owner check;
 *  - form: anything else (a range, a half day, another type). No review is saved; the card carries the leave
 *    service's own preview, and the person confirms on the Request Leave form, prefilled (leaveApplyEditHref).
 * Both carry the leave type and dates as selectors for that prefill. The model never decides days or balance. */
import {createHash} from 'node:crypto';
import {withTenant,type SessionContext} from '../../db/client';
import type {AssistantProposalHints} from '../../lib/ai/assistant-action-proposal-hints';
import {OWN_LEAVE_ACTION,OWN_LEAVE_CONTRACT_VERSION,OwnLeaveNomination,type OwnLeaveConfirmation} from '../../lib/assistant-actions/own-leave-contract';
import {prepareOwnLeaveReviewTx} from '../assistant-actions/own-leave-store';
import {isChatLeaveDuration,readOwnLeaveApplyFormCandidate,readOwnLeaveApplyMenu,type ChatLeaveDuration} from '../assistant-actions/own-leave-apply-form';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {canonicalJson,issueProposal,verifyProposal,type Proposal,type ProposalRefusal} from './proposal';

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
 const personId=ctx.personId,userId=ctx.userId;
 if(!nomination.success||!personId||!userId||prepared.review.date!==nomination.data.date)return Object.freeze({kind:'unavailable'});
 const review=prepared.review;
 return Object.freeze({kind:'proposal',proposal:issueProposal({
  what:{action:OWN_LEAVE_ACTION,contractVersion:review.contractVersion,entity:declared.entity,effect:declared.effect,
   selectors:{date:review.date,durationType:review.durationType,leaveTypeId:nomination.data.leaveTypeId},reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:nomination.data.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
  checks:passedChecks(),
  review:{route:declared.reviewRoute,href:`${declared.reviewRoute}?review=${review.actionId}`,reference:review.actionId},
  facts:{leaveType:review.leaveTypeName.slice(0,64),startDate:review.date,endDate:review.date,days:review.deductionDays,
   ...(review.estimatedAvailableAfter===null?{}:{balanceAfter:review.estimatedAvailableAfter}),outcome:'submitted_not_approved'},
  createdAt:review.createdAt,expiresAt:review.expiresAt})});
}

/** The current Assistant card hint shape: the typed selector the person verifies, plus where to review. */
export function leaveApplyCardHint(proposal:Proposal):Readonly<{action:typeof OWN_LEAVE_ACTION;hints:AssistantProposalHints;reviewHref:string;expiresAt:string}>{
 if(proposal.body.what.action!==OWN_LEAVE_ACTION)throw Error('Not a leave application proposal.');
 return Object.freeze({action:OWN_LEAVE_ACTION,hints:Object.freeze({date:proposal.body.what.selectors.date??proposal.body.what.selectors.startDate}),reviewHref:proposal.body.review.href,expiresAt:proposal.body.expiresAt});
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

/** The Request Leave form on /leave: the confirm path for a chat application the review contract cannot take. */
export const LEAVE_APPLY_FORM_ROUTE='/leave' as const;
const FORM_TTL_MS=600_000;
const FORM_CHECKS=['actor_current','ai_controls_unpaused','leave_type_eligible','deduction_and_balance'] as const;
/** A real calendar date, YYYY-MM-DD. */
export const isCalendarDate=(value:unknown):value is string=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=new Date(value+'T00:00:00.000Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};
const isUuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** At most a month of leave per chat card; longer applications go to the form directly. */
export const LEAVE_APPLY_MAX_DAYS=31;
/** Calendar dates from start to end, both included. */
export const leaveApplyDaySpan=(start:string,end:string)=>Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86_400_000)+1;

export type LeaveApplyFormInput=Readonly<{leaveTypeId:string;startDate:string;endDate:string;durationType:ChatLeaveDuration}>;
/** A proposal confirmed on the Request Leave form, from the leave service's own preview as the caller. The check
 * `deduction_and_balance` reads needs_review when the service says the balance does not cover it (or hides it), so
 * the card says so; the form refuses or converts as the leave rules decide when the person submits. */
export async function prepareLeaveApplyFormProposal(supplied:SessionContext,input:LeaveApplyFormInput,locale?:string,now:Date=new Date()):Promise<Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'unavailable'}>>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))},unavailable=Object.freeze({kind:'unavailable' as const});
 const personId=ctx.personId,userId=ctx.userId,{leaveTypeId,startDate,endDate,durationType}=input;
 if(!personId||!userId||!isUuid(leaveTypeId)||!isCalendarDate(startDate)||!isCalendarDate(endDate)||!isChatLeaveDuration(durationType)||endDate<startDate||leaveApplyDaySpan(startDate,endDate)>LEAVE_APPLY_MAX_DAYS)return unavailable;
 const candidate=await readOwnLeaveApplyFormCandidate(ctx,{leaveTypeId,startDate,endDate,durationType},locale,now);
 if(candidate.kind!=='candidate')return unavailable;
 const reviewedDigest=createHash('sha256').update(canonicalJson(['teras:leave-apply-form:v1',{tenantId:ctx.tenantId,userId,personId},
  {employmentId:candidate.employmentId,leaveTypeId,startDate,endDate,durationType,days:candidate.days}])).digest('hex');
 const checks=FORM_CHECKS.map(name=>{const check=declared.checks.find(row=>row.check===name)!;
  return{check:check.check,owner:check.owner,ruleVersion:null,result:name==='deduction_and_balance'&&!candidate.covered?'needs_review' as const:'pass' as const};});
 return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
  what:{action:OWN_LEAVE_ACTION,contractVersion:OWN_LEAVE_CONTRACT_VERSION,entity:declared.entity,effect:declared.effect,
   selectors:{startDate,endDate,durationType,leaveTypeId},reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:candidate.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
  checks,
  // The form takes the leave type (and the person's own employment, from their login); no review is saved.
  review:{route:LEAVE_APPLY_FORM_ROUTE,href:LEAVE_APPLY_FORM_ROUTE,reference:leaveTypeId},
  facts:{leaveType:candidate.leaveTypeName.slice(0,64),startDate,endDate,days:candidate.days,
   ...(candidate.availableAfter===null?{}:{balanceAfter:candidate.availableAfter}),outcome:'submitted_not_approved'},
  createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+FORM_TTL_MS).toISOString()})});
}

/** The selectors a verified leave.apply proposal carries for the form prefill, or null. */
function prefillOf(proposal:Proposal):Readonly<{leaveTypeId:string;startDate:string;endDate:string;durationType:ChatLeaveDuration}>|null{
 const {what,review,forWhom}=proposal.body,selectors=what.selectors;
 if(what.action!==OWN_LEAVE_ACTION||forWhom.subject!=='own_employment'||(review.route!==declared.reviewRoute&&review.route!==LEAVE_APPLY_FORM_ROUTE))return null;
 const startDate=selectors.startDate??selectors.date,endDate=selectors.endDate??startDate,durationType=selectors.durationType??'full_day',leaveTypeId=selectors.leaveTypeId;
 if(!isUuid(leaveTypeId)||!isCalendarDate(startDate)||!isCalendarDate(endDate)||endDate<startDate||!isChatLeaveDuration(durationType)||(durationType!=='full_day'&&endDate!==startDate))return null;
 return{leaveTypeId,startDate,endDate,durationType};
}
export type LeaveApplyEditResult=Readonly<{ok:true;href:string}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'|'unavailable'}>;
/** Edit: the Request Leave form on /leave, opened on the proposal's leave type, dates and duration. Verified for the
 * current caller, then validated again server-side as the caller: the proposal's employment must still be the
 * caller's one current own employment, the type still on their own apply menu and the duration one it allows. The
 * link only seeds the form; the form's own checks and the leave service decide when the person submits. No reason or
 * other free text is ever put in the link. */
export async function leaveApplyEditHref(caller:SessionContext,value:unknown,locale?:string,now:Date=new Date()):Promise<LeaveApplyEditResult>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const prefill=prefillOf(verified.proposal);
 if(!prefill)return{ok:false,reason:'wrong_action'};
 let menu:Awaited<ReturnType<typeof readOwnLeaveApplyMenu>>;
 try{menu=await readOwnLeaveApplyMenu(caller,locale,now);}catch{return{ok:false,reason:'unavailable'};}
 const type=menu.kind==='menu'&&menu.employmentId===verified.proposal.body.forWhom.subjectId?menu.types.find(row=>row.id===prefill.leaveTypeId):undefined;
 if(!type||(prefill.durationType!=='full_day'&&!type.durations.includes(prefill.durationType)))return{ok:false,reason:'unavailable'};
 const query=new URLSearchParams({apply:'1',applyType:type.id,start:prefill.startDate,applyEnd:prefill.endDate,applyDuration:prefill.durationType});
 return{ok:true,href:LEAVE_APPLY_FORM_ROUTE+'?'+query.toString()};
}
