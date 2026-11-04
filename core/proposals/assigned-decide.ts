/** AI v2 W2 (slice 3, batch 2a) — the assigned approver's decision on someone else's pending claim, attendance correction
 * or overtime request, prepared from chat as a signed proposal over the existing assigned-decision review custody
 * (approvals.claim.decide and approvals.attendance.decide, mirroring approvals.leave.decide).
 *
 * Nothing here decides, and the model never chooses anything that matters:
 *  - WHICH requests the caller may decide comes only from the native assigned-choice owners
 *    (core/assistant-actions/assigned-decision-review-store.ts readClaimDecisionChoices / readAttendanceDecisionChoices):
 *    the approvals inbox's own assignment rule (assertCanDecide, the frozen attendance workflow), never what the caller can
 *    merely see, and never the caller's own requests (self-approval stays refused there and again in the custody).
 *  - WHICH ONE is the person's own words this turn: the request's employee named in them ("approve Siti's claim"), matched
 *    here against the owner's stored names so no name ever reaches the model, or the number the person chose from a
 *    numbered list. A date or "overtime" in their words only narrows. Unless exactly one request is identified that way,
 *    nothing is prepared: the assigned requests are returned numbered, in a fixed order, for the model to list (names,
 *    dates and times as placeholders, amounts as bands; core/semantic-model/entities-recommend.ts suggested_action) and it
 *    asks which. It never picks one.
 *  - THE DECISION is the person's own words this turn ("approve" or "reject", never negated, never both); a decision the
 *    model passes is ignored. A rejection needs the person's own reason, which counts only when their words this turn
 *    contain it (./own-words.ts); it stays in the sealed review and never reaches the proposal or the model.
 *  - Asking to skip the review or decide in bulk prepares nothing.
 * One identified request saves a sealed review through the custody, which runs as the caller: the Assistant grant and AI
 * controls, the module, the request still pending, the caller still its assigned approver, not their own. Only then is a
 * proposal issued, carrying that review's digest, expiry and handle, and the owner's stored facts (the claim type and item,
 * the date and the amount exactly as stored; the attendance day, times and the attendance service's own overtime minutes).
 * Confirm (core/assistant-actions/assigned-decision-proposal-confirm.ts) runs the existing decision path with all its
 * checks; nothing is decided without it.
 * Spec v20 (coordinator, after run 41615455375: "Yes, I can …" with a card for a named person's request that does not
 * exist): a decision is prepared ONLY for a pending item the approvals read resolved for this approver. When nothing is
 * pending for them, when the person's words name someone none of their pending requests belongs to, or name a day or a
 * kind that the named person's requests do not have, the outcome is `no_match` (nothing prepared, no card, and the reply
 * says so plainly); when the read itself fails, `unavailable`. Never throws. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_CLAIM_DECISION_ACTION,AssignedAttendanceDecision,AssignedClaimDecision} from '../../lib/assistant-actions/assigned-decision-contract';
import {attendanceDecisionReviews,claimDecisionReviews,readAttendanceDecisionChoices,readClaimDecisionChoices} from '../assistant-actions/assigned-decision-review-store';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {isCalendarDate} from './leave-apply';
import {ownWords,squashWords} from './own-words';
import {asksToBypassReview,wordsNameDate,wordsNameNumber} from './suggested';
import {gateTurn} from '../../lib/product-context/request-gate';
import {assertProposalsConfigured,issueProposal,type Proposal,type ProposalFacts} from './proposal';
import type {z} from 'zod';

export type AssignedDecideAction=typeof ASSIGNED_CLAIM_DECISION_ACTION|typeof ASSIGNED_ATTENDANCE_DECISION_ACTION;
export const ASSIGNED_DECIDE_ACTIONS:readonly AssignedDecideAction[]=Object.freeze([ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION]);
export const isAssignedDecideAction=(value:unknown):value is AssignedDecideAction=>value===ASSIGNED_CLAIM_DECISION_ACTION||value===ASSIGNED_ATTENDANCE_DECISION_ACTION;
/** The existing review page (app/assistant/approvals/page.tsx) and the flow each decision opens on there. */
export const ASSIGNED_DECIDE_ROUTE='/assistant/approvals' as const;
export const ASSIGNED_DECIDE_FLOW:Readonly<Record<AssignedDecideAction,'claims'|'attendance'>>=Object.freeze({[ASSIGNED_CLAIM_DECISION_ACTION]:'claims',[ASSIGNED_ATTENDANCE_DECISION_ACTION]:'attendance'});
/** At most this many assigned requests are listed; the rest are counted and left to the review page. */
export const MAX_DECISION_CHOICES=10;

export type AssignedDecisionDetail='decision'|'reason';
export const DECISION_ASK_NOTE='Nothing is prepared: it is not clear whether the person wants to approve or reject. Ask them in one short question to say approve or reject, and whose request (the name or its number). Never decide for them.';
export const REASON_ASK_NOTE='Nothing is prepared: a rejection needs the approver\'s own reason. Ask them in one short question to reply in one message with reject, whose request (the name or its number) and their reason in their own words. Never write a reason for them.';
const CHOOSE_NOTES:Readonly<Record<AssignedDecideAction,string>>=Object.freeze({
 [ASSIGNED_CLAIM_DECISION_ACTION]:'Expense claims waiting for this person\'s decision are numbered in pending. Nothing is prepared. List them by number (applicant, claim type, amount and date) and ask which number, and whether to approve or reject it; for a rejection, their reason in their own words. Never choose one or decide yourself. When they answer, suggest again with that number as request in details. Claims not listed are on the review page.',
 [ASSIGNED_ATTENDANCE_DECISION_ACTION]:'Attendance corrections and overtime requests waiting for this person\'s decision are numbered in pending. Nothing is prepared. List them by number (applicant, kind, day and times) and ask which number, and whether to approve or reject it; for a rejection, their reason in their own words. Never choose one or decide yourself. When they answer, suggest again with that number as request in details. Requests not listed are on the review page.',
});

/** One assigned request the approver is asked to choose between: its number and the owner's stored labels, no handle.
 * Disclosed under suggested_action: the applicant, the date and the times leave as placeholders, the amount as a band. */
export type AssignedDecisionChoice=Readonly<{request:number;applicant:string;date:string;
 claimType?:string;claimItem?:string;amount?:string;
 kind?:'overtime'|'correction';plannedStart?:string;plannedEnd?:string;checkIn?:string;checkOut?:string}>;
export type AssignedDecideOutcome=Readonly<{kind:'proposal';proposal:Proposal}>
 |Readonly<{kind:'choose';pending:readonly AssignedDecisionChoice[];more:number;note:string}>
 |Readonly<{kind:'ask';missing:readonly AssignedDecisionDetail[];options:readonly never[];note:string}>
 |DecisionNoMatch|DecisionUnavailable;
/** Spec v20: nothing pending for this approver matches the person's words. Nothing is prepared. */
export type DecisionNoMatch=Readonly<{kind:'no_match';note:string}>;
/** Spec v20: whether anything is pending for this approver could not be read. Nothing is prepared. */
export type DecisionUnavailable=Readonly<{kind:'unavailable';note:string}>;
const NO_MATCH_WHAT:Readonly<Record<AssignedDecideAction|'approvals.leave.decide',string>>=Object.freeze({
 [ASSIGNED_CLAIM_DECISION_ACTION]:'expense claim',[ASSIGNED_ATTENDANCE_DECISION_ACTION]:'attendance correction or overtime request','approvals.leave.decide':'leave request'});
/** The no-match note for one decision action: said plainly, with the approvals page, never offered as a card. */
export const noMatchNote=(action:AssignedDecideAction|'approvals.leave.decide')=>`No pending ${NO_MATCH_WHAT[action]} matching what the person said is waiting for their decision (none from the person they named, on the day or of the kind they said, or none at all). Nothing is prepared and there is no card. Say so plainly in one line, without "Yes, I can", and link the approvals page; never say they can decide it here.`;
export const DECISION_UNAVAILABLE_NOTE='What is waiting for this person\'s decision could not be checked just now. Nothing is prepared and there is no card. Say so in one line and link the approvals page.';
export const decisionNoMatch=(action:AssignedDecideAction|'approvals.leave.decide'):DecisionNoMatch=>Object.freeze({kind:'no_match' as const,note:noMatchNote(action)});
const unavailable=():DecisionUnavailable=>Object.freeze({kind:'unavailable' as const,note:DECISION_UNAVAILABLE_NOTE});
/** The person's own words this turn name someone other than themselves (the pre-read gate's own rule). */
export const wordsNameSomeone=(words:string|undefined)=>typeof words==='string'&&(()=>{const gate=gateTurn(words);return !gate.privateReads&&gate.reason==='other_person';})();

const ask=(missing:AssignedDecisionDetail,note:string):AssignedDecideOutcome=>Object.freeze({kind:'ask' as const,missing:Object.freeze([missing]),options:Object.freeze([]) as readonly never[],note});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const declared=(action:AssignedDecideAction)=>SEMANTIC_ACTIONS.find(row=>row.id===action)!;

const NEGATION=String.raw`(?:\bdo\s+not|\bdon['’]?t|\bdont|\bnever|\bnot|\bjangan|\btak|\btidak|\bbelum)\s+(?:\S+\s+){0,2}?`;
const APPROVE=/\b(?:approve|lulus(?:kan)?)\b/i,REJECT=/\b(?:reject|decline|tolak)\b/i;
const NEGATED_APPROVE=new RegExp(NEGATION+String.raw`(?:approve|lulus)`,'i'),NEGATED_REJECT=new RegExp(NEGATION+String.raw`(?:reject|decline|tolak)`,'i');
/** The person's own decision in their words this turn: approve or reject, never negated, never both, never in bulk. */
export function decisionInWords(words:string|undefined):'approved'|'rejected'|null{
 if(typeof words!=='string'||asksToBypassReview(words))return null;
 const approve=APPROVE.test(words)&&!NEGATED_APPROVE.test(words),reject=REJECT.test(words)&&!NEGATED_REJECT.test(words);
 if(NEGATED_APPROVE.test(words)||NEGATED_REJECT.test(words))return null;
 return approve===reject?null:approve?'approved':'rejected';
}

const CONNECTORS=new Set(['bin','binti','bt','bte','a/l','a/p','al','ap','s/o','d/o','@','van','von','de']);
const letters=String.raw`[\p{L}\p{N}]`;
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const asWord=(token:string,words:string)=>new RegExp(`(?<!${letters})${escape(token)}(?!${letters})`,'iu').test(words);
/** The person's own words name this employee: the full stored name, or its first name as a whole word. Local only: the
 * stored name is never sent anywhere. */
export function wordsNameEmployee(words:string|undefined,employeeName:string):boolean{
 if(typeof words!=='string')return false;
 const said=squashWords(words),name=squashWords(employeeName);
 if(name.length>=2&&said.includes(name))return true;
 const first=name.split(' ').find(token=>token.length>=2&&!CONNECTORS.has(token));
 return first!==undefined&&asWord(first,said);
}
const WEEKDAYS:readonly (readonly string[])[]=[['sunday','sun','ahad'],['monday','mon','isnin'],['tuesday','tue','tues','selasa'],['wednesday','wed','rabu'],
 ['thursday','thu','thur','thurs','khamis'],['friday','fri','jumaat'],['saturday','sat','sabtu']];
const dayNumber=(date:string)=>Math.floor(Date.parse(date+'T00:00:00Z')/86_400_000);
/** The person's own words name this date: as a calendar date (./suggested.ts wordsNameDate), or as its weekday when it
 * is within a week of today on the HR date owner ("the overtime for Ravi on Tuesday"). */
export function wordsNameDay(words:string|undefined,iso:string,today:string):boolean{
 if(wordsNameDate(words,iso))return true;
 if(typeof words!=='string'||!isCalendarDate(iso)||Math.abs(dayNumber(iso)-dayNumber(today))>7)return false;
 return WEEKDAYS[new Date(iso+'T00:00:00Z').getUTCDay()].some(name=>asWord(name,words));
}
const OVERTIME=/\b(?:overtime|ot|lebih\s+masa|kerja\s+lebih)\b/i,CORRECTION=/\b(?:correction|correct|clock(?:-?in|-?out|ing)?|punch|check-?in|check-?out|attendance)\b/i;

type ClaimItem=z.infer<typeof AssignedClaimDecision.Item>;
type AttendanceItem=z.infer<typeof AssignedAttendanceDecision.Item>;
type Item=Readonly<{subjectId:string;employmentId:string;employeeName:string;date:string;overtime?:boolean}>;
const text=(details:Readonly<Record<string,unknown>>,...keys:string[])=>{for(const key of keys){const value=details[key];if(typeof value==='string'&&value.trim())return value.trim();}return '';};
const ordered=<T extends Item>(items:readonly T[])=>[...items].sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName)||a.subjectId.localeCompare(b.subjectId));

/** Which requests the person's own words identify, out of the assigned ones in their fixed order. `none`: the words name
 * someone, or a day or kind of the named person's requests, that nothing pending matches (spec v20: no match). */
function identified<T extends Item>(all:readonly T[],details:Readonly<Record<string,unknown>>,words:string|undefined,today:string,attendance:boolean):Readonly<{one:T|null;candidates:readonly T[];none:boolean}>{
 const given=text(details,'request'),number=/^\d{1,2}$/.test(given)&&wordsNameNumber(words,Number(given))?Number(given):null;
 if(number!==null)return number>=1&&number<=all.length?{one:all[number-1],candidates:[all[number-1]],none:false}:{one:null,candidates:all,none:false};
 let candidates=all.filter(item=>wordsNameEmployee(words,item.employeeName));
 const named=candidates.length>0;
 // A person named whose requests are not among this approver's pending ones: none, never someone else's request.
 if(!named&&wordsNameSomeone(words))return{one:null,candidates:[],none:true};
 if(!named)candidates=[...all];
 const date=text(details,'date','incurredOn','startDate');
 if(isCalendarDate(date)&&wordsNameDay(words,date,today)){const dated=candidates.filter(item=>item.date===date);
  if(dated.length)candidates=dated;else if(named)return{one:null,candidates:[],none:true};}
 if(attendance&&typeof words==='string'){
  const overtime=OVERTIME.test(words),correction=CORRECTION.test(words);
  if(overtime!==correction){const kind=candidates.filter(item=>item.overtime===overtime);
   if(kind.length)candidates=kind;else if(named)return{one:null,candidates:[],none:true};}
 }
 // Only a name or a number the person said identifies a request; a date or a kind alone never does.
 return{one:named&&candidates.length===1?candidates[0]:null,candidates,none:false};
}

function claimChoice(item:ClaimItem,index:number):AssignedDecisionChoice{
 return Object.freeze({request:index+1,applicant:item.employeeName.slice(0,240),date:item.incurredOn,claimType:item.claimTypeName.slice(0,64),
  ...(item.itemName?{claimItem:item.itemName.slice(0,64)}:{}),amount:item.amount});
}
function attendanceChoice(item:AttendanceItem,index:number):AssignedDecisionChoice{
 return Object.freeze({request:index+1,applicant:item.employeeName.slice(0,240),date:item.date,kind:item.overtime?'overtime' as const:'correction' as const,
  ...(item.plannedStartTime?{plannedStart:item.plannedStartTime.slice(0,5)}:{}),...(item.plannedEndTime?{plannedEnd:item.plannedEndTime.slice(0,5)}:{}),
  ...(item.proposedCheckIn?{checkIn:item.proposedCheckIn.slice(0,5)}:{}),...(item.proposedCheckOut?{checkOut:item.proposedCheckOut.slice(0,5)}:{})});
}

const CLOCK=/^(?:[01]\d|2[0-3]):[0-5]\d$/,AMOUNT=/^\d{1,9}\.\d{2}$/;
const clock=(value:string|null|undefined)=>{const hhmm=value?.slice(0,5);return hhmm&&CLOCK.test(hhmm)?hhmm:undefined;};
/** Only the clock times the owner stored, each HH:MM. */
const times=(values:Readonly<Record<'plannedStart'|'plannedEnd'|'checkIn'|'checkOut',string|undefined>>):Pick<ProposalFacts,'plannedStart'|'plannedEnd'|'checkIn'|'checkOut'>=>
 Object.fromEntries(Object.entries(values).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));

/** The decision on one assigned claim or attendance request from a chat turn. `details` is the model's suggestion:
 * request (a number from the list), date, reason; only what the person's own words this turn contain counts. */
export async function prepareChatAssignedDecisionProposal(supplied:SessionContext,action:AssignedDecideAction,details:Readonly<Record<string,unknown>>,personWords:string|undefined,now:Date=new Date()):Promise<AssignedDecideOutcome|null>{
 const ctx=capture(supplied);
 try{
  const userId=ctx.userId,personId=ctx.personId;
  if(!userId||!personId||!isAssignedDecideAction(action)||asksToBypassReview(personWords))return null;
  const decision=decisionInWords(personWords);
  if(!decision)return ask('decision',DECISION_ASK_NOTE);
  const today=todayInKualaLumpur(now),claims=action===ASSIGNED_CLAIM_DECISION_ACTION;
  // The approvals inbox's own assignment rule, as the caller; never the caller's own requests. Read through the
  // contract's own schema: anything else is unavailable.
  if(claims){
   const read=AssignedClaimDecision.Choices.safeParse(await readClaimDecisionChoices(ctx));
   if(!read.success||read.data.kind!=='choices')return unavailable();
   if(!read.data.items.length)return decisionNoMatch(action);
   const truncated=read.data.truncated,all=ordered(read.data.items.map(item=>({...item,date:item.incurredOn})));
   const pick=identified(all,details,personWords,today,false);
   if(pick.none)return decisionNoMatch(action);
   if(!pick.one)return choose(action,pick.candidates.map(item=>claimChoice(item,all.indexOf(item))),pick.candidates.length,truncated);
   const reason=decision==='rejected'?ownWords(details.reason,personWords,1000):null;
   if(decision==='rejected'&&!reason)return ask('reason',REASON_ASK_NOTE);
   return await claimProposal(ctx,userId,personId,pick.one,decision,reason);
  }
  const read=AssignedAttendanceDecision.Choices.safeParse(await readAttendanceDecisionChoices(ctx));
  if(!read.success||read.data.kind!=='choices')return unavailable();
  if(!read.data.items.length)return decisionNoMatch(action);
  const truncated=read.data.truncated,all=ordered(read.data.items);
  const pick=identified(all,details,personWords,today,true);
  if(pick.none)return decisionNoMatch(action);
  if(!pick.one)return choose(action,pick.candidates.map(item=>attendanceChoice(item,all.indexOf(item))),pick.candidates.length,truncated);
  const reason=decision==='rejected'?ownWords(details.reason,personWords,1000):null;
  if(decision==='rejected'&&!reason)return ask('reason',REASON_ASK_NOTE);
  return await attendanceProposal(ctx,userId,personId,pick.one,decision,reason);
 }catch{return unavailable();}
}

function choose(action:AssignedDecideAction,pending:readonly AssignedDecisionChoice[],count:number,truncated:boolean):AssignedDecideOutcome{
 // `more` counts the assigned requests not listed; when the owner itself truncated, at least one more exists.
 return Object.freeze({kind:'choose' as const,pending:Object.freeze(pending.slice(0,MAX_DECISION_CHOICES)),more:Math.max(0,count-MAX_DECISION_CHOICES)+(truncated?1:0),note:CHOOSE_NOTES[action]});
}

function issue(ctx:SessionContext,userId:string,personId:string,action:AssignedDecideAction,subjectId:string,
 review:Readonly<{actionId:string;reviewedDigest:string;createdAt:string;expiresAt:string}>,selectors:Record<string,string>,facts:ProposalFacts):AssignedDecideOutcome{
 const owner=declared(action),route=ASSIGNED_DECIDE_ROUTE;
 return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
  what:{action,contractVersion:1,entity:owner.entity,effect:owner.effect,selectors,reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'assigned_request',subjectId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
  // The custody ran each of these as the caller; a failed one prepares no review and so issues no proposal.
  checks:owner.checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const})),
  review:{route,href:`${route}?flow=${ASSIGNED_DECIDE_FLOW[action]}&review=${review.actionId}`,reference:review.actionId},
  facts,createdAt:review.createdAt,expiresAt:review.expiresAt})});
}

async function claimProposal(ctx:SessionContext,userId:string,personId:string,item:ClaimItem,decision:'approved'|'rejected',reason:string|null):Promise<AssignedDecideOutcome|null>{
 if(!AMOUNT.test(item.amount))return null;
 assertProposalsConfigured();
 const prepared=await claimDecisionReviews.prepare(ctx,{action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision,
  ...(decision==='rejected'&&reason?{note:reason}:{})});
 if(prepared.kind!=='prepared')return null;
 const review=prepared.review,stored=review.review;
 if(review.content.subjectId!==item.subjectId||review.content.decision!==decision||stored.subjectId!==item.subjectId||!AMOUNT.test(stored.amount))return null;
 return issue(ctx,userId,personId,ASSIGNED_CLAIM_DECISION_ACTION,item.subjectId,review,{incurredOn:stored.incurredOn,decision},
  {claimType:stored.claimTypeName.slice(0,64),...(stored.itemName?{claimItem:stored.itemName.slice(0,64)}:{}),incurredOn:stored.incurredOn,amount:stored.amount,decision,
   outcome:decision==='rejected'?'rejection_if_confirmed':'approval_if_native_checks_pass'});
}

async function attendanceProposal(ctx:SessionContext,userId:string,personId:string,item:AttendanceItem,decision:'approved'|'rejected',reason:string|null):Promise<AssignedDecideOutcome|null>{
 assertProposalsConfigured();
 const prepared=await attendanceDecisionReviews.prepare(ctx,{action:ASSIGNED_ATTENDANCE_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision,
  ...(decision==='rejected'&&reason?{note:reason}:{})});
 if(prepared.kind!=='prepared')return null;
 const review=prepared.review,stored=review.review;
 if(review.content.subjectId!==item.subjectId||review.content.decision!==decision||stored.subjectId!==item.subjectId||!isCalendarDate(stored.date))return null;
 const kind=stored.overtime?'overtime':'correction',minutes=stored.requestedOtMinutes;
 const facts:ProposalFacts={startDate:stored.date,endDate:stored.date,decision,
  // The attendance service's own window and minute count; never a pay figure.
  ...times({plannedStart:clock(stored.plannedStartTime),plannedEnd:clock(stored.plannedEndTime),checkIn:clock(stored.proposedCheckIn),checkOut:clock(stored.proposedCheckOut)}),
  ...(typeof minutes==='number'&&Number.isInteger(minutes)&&minutes>0?{overtimeMinutes:minutes}:{}),
  outcome:decision==='rejected'?'rejection_if_confirmed':'attendance_decision_if_checks_pass'};
 return issue(ctx,userId,personId,ASSIGNED_ATTENDANCE_DECISION_ACTION,item.subjectId,review,{date:stored.date,kind,decision},facts);
}
