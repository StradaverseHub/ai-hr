/** AI v2 W2 (slice 2) — the caller's own Leave Credit request (time off in lieu) prepared from chat, as a signed
 * proposal over the existing TOIL review custody ("do, don't point").
 *
 * The model only nominates: the date worked (YYYY-MM-DD, never after today on the Asia/Kuala_Lumpur HR date owner), the
 * start and end of the work (HH:MM, 24-hour; an earlier end crosses midnight, as the Leave Credit form reads it) and, at
 * most, the person's own reason. Everything else comes from the owners, and nothing here writes a request:
 *  - whether the person may ask at all, which credit type, and whether an ordinary working day can earn a credit come from
 *    the TOIL request choices (core/assistant-actions/module-action-server.ts readToilRequestModuleActionChoices), the
 *    same read the existing TOIL review page offers; the day type is what the roster holds (own-toil-worked-day.ts),
 *    exactly as the Leave Credit form fills it;
 *  - the existing TOIL review custody (core/assistant-actions/toil-request-review-store.ts) runs the leave service's own
 *    preparation as the caller and saves the sealed review. The days on the card (`creditDays`) are that review's own
 *    total, counted by the Leave Credit rules (core/toil.ts leaveCreditClaimReview). No figure is computed here.
 *  - First Schedule (owner decision, 3 November 2026: "Employee ticks consent on card"): the leave service decides who
 *    is within the First Schedule (replacementRequestAvailability). For such a person the review is prepared with the
 *    agreement still to be asked for (`firstScheduleConsentPending`), which the leave service never writes as a request;
 *    the card shows the form's own agreement sentence with an unticked box, and only the person's own tick, posted at
 *    Confirm, gives it (core/assistant-actions/toil-request-proposal-confirm.ts). The proposal carries only that the
 *    agreement is asked for (`firstScheduleAgreement: 'required'`), never the agreement; anything the model sends about
 *    consent is ignored.
 * Missing or unclear details are returned for one question. A reason counts only when it is the person's own words this
 * turn; it stays in the sealed review and never reaches the proposal. */
import type {SessionContext} from '../../db/client';
import {myEmployment} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {ownWorkedDayKind} from '../assistant-actions/own-toil-worked-day';
import {readToilRequestModuleActionChoices} from '../assistant-actions/module-action-server';
import {toilRequestReviews} from '../assistant-actions/toil-request-review-store';
import {OWN_TOIL_REPLACEMENT_ACTION,type OwnToilReplacementHumanContent} from '../../lib/assistant-actions/own-toil-replacement-contract';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {isCalendarDate} from './leave-apply';
import {ownWords} from './own-words';
import {assertProposalsConfigured,issueProposal,verifyProposal,type Proposal,type ProposalRefusal} from './proposal';

export const TOIL_REQUEST_ACTION=OWN_TOIL_REPLACEMENT_ACTION;
const CONTRACT_VERSION=1 as const;
/** The existing TOIL review page (app/assistant/toil/page.tsx), the registry's review route. */
export const TOIL_REVIEW_ROUTE='/assistant/toil' as const;
/** Edit opens the Leave Credit request dialog on My Leave (app/leave/page.tsx, lib/leave-credit-prefill.ts). */
export const LEAVE_CREDIT_FORM_ROUTE='/leave' as const;
/** The selector that says the person's own First Schedule agreement is asked for on the card. Never the agreement. */
export const FIRST_SCHEDULE_AGREEMENT_SELECTOR='firstScheduleAgreement' as const;

export const TOIL_REQUEST_DETAILS=['workedDate','claimStart','claimEnd','reason'] as const;
export type ToilRequestDetail=typeof TOIL_REQUEST_DETAILS[number];
export const TOIL_ASK_NOTE='Some details for this Leave Credit request are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them: workedDate is the date they worked, claimStart and claimEnd the time they started and finished, reason their own words for it. Never guess a date, a time or a reason.';
export type ToilChatOutcome=Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'ask';missing:readonly ToilRequestDetail[];options:readonly never[];note:string}>;

const declared=()=>SEMANTIC_ACTIONS.find(action=>action.id===TOIL_REQUEST_ACTION)!;
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const text=(details:Readonly<Record<string,unknown>>,...keys:string[])=>{for(const key of keys){const value=details[key];if(typeof value==='string'&&value.trim())return value.trim();}return '';};
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const ask=(missing:ToilRequestDetail[])=>Object.freeze({kind:'ask' as const,missing:Object.freeze([...new Set(missing)]),options:Object.freeze([]) as readonly never[],note:TOIL_ASK_NOTE});

/** A Leave Credit request for one date the caller worked, from a chat turn. `details`: workedDate, claimStart and
 * claimEnd (HH:MM), reason. Null when the caller cannot ask for a Leave Credit here (module, company switches,
 * eligibility, a First Schedule employee whose company does not allow it), the date is an ordinary working day the
 * company does not credit, or the leave service refuses the preparation: the suggestion then stays a pointer to the
 * review page. Never throws. */
export async function prepareChatToilRequestProposal(supplied:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined,now:Date=new Date()):Promise<ToilChatOutcome|null>{
 const ctx=capture(supplied);
 try{
  const userId=ctx.userId,personId=ctx.personId;if(!userId||!personId)return null;
  const own=await myEmployment(ctx);if(!own)return null;
  // The owner's own offer: this employment may ask, which credit type, ordinary days, and First Schedule.
  const choices=await readToilRequestModuleActionChoices(ctx);
  if(choices.kind!=='choices')return null;
  const subject=choices.employments.find(row=>row.employmentId===own.employmentId);if(!subject)return null;
  const workedDate=text(details,'workedDate','date','startDate'),claimStart=text(details,'claimStart','startTime','start','fromTime'),claimEnd=text(details,'claimEnd','endTime','end','toTime');
  const missing:ToilRequestDetail[]=[];
  if(!isCalendarDate(workedDate)||workedDate>todayInKualaLumpur(now))missing.push('workedDate');
  if(!isClock(claimStart))missing.push('claimStart');
  if(!isClock(claimEnd)||claimEnd===claimStart)missing.push('claimEnd');
  const reason=ownWords(details.reason,personWords,500);
  if(!reason)missing.push('reason');
  if(missing.length||!reason)return ask(missing);
  // What the roster holds for that date, as the Leave Credit form fills it; the leave service adjudicates it again.
  const dayType=await ownWorkedDayKind(ctx,own.employmentId,workedDate);
  if(dayType==='workday'&&!subject.ordinaryDayAllowed)return null;
  const agreementAsked=subject.requiresFirstScheduleConsent===true;
  assertProposalsConfigured();
  const human:OwnToilReplacementHumanContent={action:TOIL_REQUEST_ACTION,contractVersion:CONTRACT_VERSION,engine:'leave_credit_rows',employmentId:own.employmentId,
   leaveTypeId:subject.replacementType?.id??null,
   // Never the model's: the agreement is only ever the person's own tick on the card, at Confirm.
   firstScheduleConsent:false,...(agreementAsked?{firstScheduleConsentPending:true as const}:{}),
   reason,rows:[{workedDate,dayType,claimStart,claimEnd}]};
  const prepared=await toilRequestReviews.prepare(ctx,human);
  if(prepared.kind!=='prepared')return null;
  const review=prepared.review,native=review.review;
  if(native.employmentId!==own.employmentId||native.lines.length!==1||native.lines[0].workedDate!==workedDate||native.firstScheduleConsent!==false
   ||!Number.isFinite(native.totalDays)||native.totalDays<=0)return null;
  const action=declared();
  return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
   what:{action:TOIL_REQUEST_ACTION,contractVersion:CONTRACT_VERSION,entity:action.entity,effect:action.effect,
    selectors:{workedDate,dayType,claimStart,claimEnd,...(agreementAsked?{[FIRST_SCHEDULE_AGREEMENT_SELECTOR]:'required'}:{})},reviewedDigest:review.reviewedDigest},
   forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:own.employmentId},
   authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
   checks:action.checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const})),
   review:{route:TOIL_REVIEW_ROUTE,href:`${TOIL_REVIEW_ROUTE}?review=${review.actionId}`,reference:review.actionId},
   // The leave service's own count of the credit, and the window the person gave. Never a pay figure.
   facts:{startDate:workedDate,endDate:workedDate,plannedStart:claimStart,plannedEnd:claimEnd,creditDays:native.totalDays,outcome:'submitted_not_approved'},
   createdAt:review.createdAt,expiresAt:review.expiresAt})});
 }catch{return null;}
}

export type ToilProposalRefusal=ProposalRefusal|'wrong_action';
/** What a verified TOIL card names, for the current caller only: its review handle and digest, whether the person's own
 * First Schedule agreement is asked for, and the credit the card showed. */
export function toilReviewConfirmation(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;actionId:string;reviewedDigest:string;employmentId:string;
 agreementAsked:boolean;creditDays:number}>|Readonly<{ok:false;reason:ToilProposalRefusal}>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review,forWhom,facts}=verified.proposal.body,creditDays=facts?.creditDays;
 if(what.action!==TOIL_REQUEST_ACTION||what.contractVersion!==CONTRACT_VERSION||review.route!==TOIL_REVIEW_ROUTE||forWhom.subject!=='own_employment'
  ||typeof creditDays!=='number')return{ok:false,reason:'wrong_action'};
 return Object.freeze({ok:true as const,actionId:review.reference,reviewedDigest:what.reviewedDigest,employmentId:forWhom.subjectId,
  agreementAsked:what.selectors[FIRST_SCHEDULE_AGREEMENT_SELECTOR]==='required',creditDays});
}

export type ToilEditResult=Readonly<{ok:true;href:string}>|Readonly<{ok:false;reason:ToilProposalRefusal|'unavailable'}>;
/** Edit: the Leave Credit request dialog on My Leave, opened on the card's date and window and validated again
 * server-side as the caller — the proposal's employment must still be the caller's current own employment, the date a
 * real day not in the future, the times well formed and different. The link only seeds the form; its own checks and the
 * leave service decide when the person submits. No reason, no agreement and no other free text is ever put in the link:
 * the person ticks the agreement themselves on the form. */
export async function toilEditHref(caller:SessionContext,value:unknown,now:Date=new Date()):Promise<ToilEditResult>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review,forWhom}=verified.proposal.body,selectors=what.selectors;
 if(what.action!==TOIL_REQUEST_ACTION||review.route!==TOIL_REVIEW_ROUTE||forWhom.subject!=='own_employment')return{ok:false,reason:'wrong_action'};
 let own:Awaited<ReturnType<typeof myEmployment>>;
 try{own=await myEmployment(capture(caller));}catch{return{ok:false,reason:'unavailable'};}
 const workedDate=selectors.workedDate,claimStart=selectors.claimStart,claimEnd=selectors.claimEnd;
 if(!own||own.employmentId!==forWhom.subjectId||!isCalendarDate(workedDate)||workedDate>todayInKualaLumpur(now)
  ||!isClock(claimStart)||!isClock(claimEnd)||claimStart===claimEnd)return{ok:false,reason:'unavailable'};
 return{ok:true,href:LEAVE_CREDIT_FORM_ROUTE+'?'+new URLSearchParams({credit:'1',creditDate:workedDate,creditStart:claimStart,creditEnd:claimEnd}).toString()};
}
