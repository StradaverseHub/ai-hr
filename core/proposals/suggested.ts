/** ADR-0170 step 2 — the proposal a harness turn issues when the model suggests a leave card action.
 *
 * The model only points: its suggestion names an action and, at most, the typed selectors the semantic model
 * declares nominable (a date). Everything else comes from the caller's own records and the person's own words,
 * and the native preparer decides:
 *  - leave.cancel: the caller's one own pending or approved request starting on the nominated date (or their
 *    only one, when no date is given). Ambiguity issues nothing; the review page asks.
 *  - approvals.leave.decide: the one request currently assigned to the caller, and only when the person's own
 *    words ask to approve it (a negation such as "do not approve" or "jangan lulus" never does). The requests
 *    come from the native assigned-choice owner (core/leave.ts pendingLeaveDecisionChoiceMetadataTx, read through
 *    core/assistant-actions/module-action-server.ts readAssignedLeaveModuleActionChoices and assignedLeaveDecisionChoices below), never from what the caller can merely see. With several assigned (or
 *    several on the nominated date), nothing is prepared: they are returned, numbered in a fixed order, for the
 *    model to list, and it asks which one (ADR-0170 §3.15). It never picks one. The person answers with a number
 *    (`request` in details), which picks the request at that place in the same order now. A number or date the
 *    model passes counts only when the person's own words this turn contain it; otherwise it is ignored and the
 *    person is asked. A rejection needs the person's own reason, so it is never prepared here.
 *  - leave.apply (issue 10): the caller's own leave only. The model names a leave type, dates, a duration and at most
 *    a reason; the type resolves only against the caller's own apply menu, and the reason counts only when it is the
 *    person's own words this turn. Missing or unclear details are asked for in one question (the menu numbered when
 *    the type is unclear); otherwise ./leave-apply.ts issues the review proposal (one full day) or the form proposal.
 *  - attendance.correction.request and attendance.overtime.request (AI v2 W2): the caller's own attendance only, through
 *    ./attendance-request.ts; missing details are asked for in one question, and the attendance service decides.
 *  - toil.replacement.request (AI v2 W2, slice 2): the caller's own Leave Credit request for one date worked, through
 *    ./toil-request.ts; the leave service counts the credit, and a First Schedule agreement is only the person's own tick.
 *  - approvals.claim.decide and approvals.attendance.decide (AI v2 W2, slice 3): the assigned approver's own decision on one
 *    assigned claim, attendance correction or overtime request, through ./assigned-decide.ts; the request is the one their
 *    own words name, the decision and any rejection reason are their own words, and the existing decision path decides.
 * Returns null when neither a proposal, a choice nor a question is issued; never throws. */
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {leaveRequest,leaveType} from '../../db/schema';
import {readAssignedLeaveModuleActionChoices} from '../assistant-actions/module-action-server';
import {listLeaveRequests} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {isCalendarDate,LEAVE_APPLY_MAX_DAYS,leaveApplyDaySpan,prepareLeaveApplyFormProposal,prepareLeaveApplyProposal} from './leave-apply';
import {prepareLeaveCancelProposal} from './leave-cancel';
import {isChatLeaveDuration,readOwnLeaveApplyMenu,type ChatLeaveDuration,type OwnLeaveApplyType} from '../assistant-actions/own-leave-apply-form';
import {OWN_LEAVE_ACTION,OWN_LEAVE_CONTRACT_VERSION} from '../../lib/assistant-actions/own-leave-contract';
import {matchLeaveTypeWords} from './leave-type-match';
import {prepareLeaveDecideProposal} from './leave-decide';
import type {Proposal} from './proposal';
import {PENDING_STARTS} from '../semantic-model/entities-recommend';
import {prepareChatAttendanceCorrectionProposal,prepareChatOvertimeRequestProposal,type AttendanceChatOutcome} from './attendance-request';
import {prepareChatClaimSubmitProposal,type OwnChangeAsk} from './claim-submit';
import {prepareChatClaimCancelProposal} from './claim-cancel';
import {prepareChatProfileChangeProposal} from './profile-change';
import {prepareChatToilRequestProposal,type ToilChatOutcome} from './toil-request';
import {decisionNoMatch,isAssignedDecideAction,prepareChatAssignedDecisionProposal,wordsNameEmployee,wordsNameSomeone,type AssignedDecideOutcome} from './assigned-decide';
import {requestDates,type RequestDates} from './request-dates';

const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
/** "Do not approve", "don't approve", "never approve", "not yet approve", "jangan lulus", "tak approve": a negation
 * up to two words before approve (or the Malay lulus). */
const NEGATED_APPROVE=/(?:\bdo\s+not|\bdon['\u2019]?t|\bdont|\bdid\s+not|\bdidn['\u2019]?t|\bnever|\bnot|\bjangan|\btak|\btidak|\bbelum)\s+(?:\S+\s+){0,2}?(?:approve|lulus)/i;
/** Asking to skip the review or decide in bulk ("approve everything directly, skip the card"): no decision is prepared or
 * suggested for it (model run 41360905376, mgr-pending-injection-4). Every decision is confirmed one by one on its page. */
const BYPASS_REVIEW=/\b(everything|every\s+(one|request|leave)|all\s+(of\s+(them|it)|requests?|leaves?|pending|at\s+once)|approve\s+all|skip(ping)?\s+(the\s+)?(card|review|confirm\w*|page|step)|directly|without\s+(the\s+)?(card|review|confirm\w*|checking|looking)|bypass\w*|auto[- ]?approv\w*|in\s+bulk|bulk[- ]approv\w*)\b/i;
export const asksToBypassReview=(words:string|undefined)=>typeof words==='string'&&BYPASS_REVIEW.test(words);
/** The person asks to approve, does not negate it, does not also mention rejecting, and does not ask to skip the review
 * or approve in bulk. Only the person's words are read. */
export const asksToApprove=(words:string|undefined)=>typeof words==='string'&&/\bapprove\b/i.test(words)&&!NEGATED_APPROVE.test(words)
 &&!/\b(reject|decline|deny|refuse)\b/i.test(words)&&!asksToBypassReview(words);

const NUMBER_WORDS:Readonly<Record<number,readonly string[]>>={1:['one','first','satu','pertama'],2:['two','second','dua','kedua'],3:['three','third','tiga','ketiga'],
 4:['four','fourth','empat','keempat'],5:['five','fifth','lima','kelima'],6:['six','sixth','enam','keenam'],7:['seven','seventh','tujuh','ketujuh'],
 8:['eight','eighth','lapan','kelapan'],9:['nine','ninth','sembilan','kesembilan'],10:['ten','tenth','sepuluh','kesepuluh']};
/** The person's own words name this request number: the digits as a whole token (2, #2, no. 2) or the number word. */
export function wordsNameNumber(words:string|undefined,request:number):boolean{
 if(typeof words!=='string'||!Number.isInteger(request)||request<1)return false;
 if(new RegExp(`(?<![\\d.:/-])${request}(?![\\d.:/-]\\d)`).test(words))return true;
 return (NUMBER_WORDS[request]??[]).some(word=>new RegExp(`\\b${word}\\b`,'i').test(words));
}
const MONTHS:readonly (readonly string[])[]=[['jan','january','januari'],['feb','february','februari'],['mar','march','mac'],['apr','april'],['may','mei'],
 ['jun','june'],['jul','july','julai'],['aug','august','ogos','ogo'],['sep','sept','september'],['oct','october','oktober','okt'],['nov','november'],['dec','december','disember','dis']];
/** The person's own words name this date: 2026-11-05, 5/11 or 5/11/2026, "5 Nov", "Nov 5", "5hb November". */
export function wordsNameDate(words:string|undefined,iso:string):boolean{
 if(typeof words!=='string'||!isDate(iso))return false;
 if(words.includes(iso))return true;
 const [,month,day]=iso.split('-').map(Number),d=String(day),m=String(month);
 if(new RegExp(`(?<!\\d)0?${d}[/.-]0?${m}(?:[/.-](?:\\d{2}|\\d{4}))?(?!\\d)`).test(words))return true;
 const names=MONTHS[month-1].join('|');
 return new RegExp(`(?<!\\d)0?${d}(?:st|nd|rd|th|hb)?\\s+(?:of\\s+)?(?:${names})\\b`,'i').test(words)
  ||new RegExp(`\\b(?:${names})\\.?\\s+0?${d}(?:st|nd|rd|th)?(?!\\d)`,'i').test(words);
}

/** One request the native owner assigns the caller to decide now, with what the chooser shows. */
export type AssignedLeaveChoice=Readonly<{id:string;currentStepId:string|null;applicant:string;leaveType:string;days:unknown;startDate:string;endDate:string}>;
/** The leave requests the caller is assigned to decide now, from the native assigned-choice owner
 * (core/leave.ts pendingLeaveDecisionChoiceMetadataTx: the approvals inbox's own assignment rule), in the fixed
 * order the chooser numbers them (start date, applicant, id). Never a request the caller can merely see.
 * `truncated` is the owner's own flag: more were assigned than it lists. Shared with the harness so the queue
 * read and the chooser use one set. */
export async function assignedLeaveDecisionChoices(ctx:SessionContext):Promise<Readonly<{choices:readonly AssignedLeaveChoice[];truncated:boolean}>>{
 // The assigned-leave action's own read-only owner (it reaches pendingLeaveDecisionChoiceMetadataTx after the reviewed
 // decision actor check); a proposal module never imports the leave service with its write paths. Unavailable is empty.
 const assigned=await readAssignedLeaveModuleActionChoices(ctx);
 const tasks=assigned.kind==='choices'?assigned.tasks:[],truncated=assigned.kind==='choices'&&assigned.truncated;
 return withTenant(ctx,async tx=>{
  if(!tasks.length)return Object.freeze({choices:Object.freeze([]),truncated});
  const rows=await tx.select({id:leaveRequest.id,startDate:leaveRequest.startDate,endDate:leaveRequest.endDate,days:leaveRequest.days,leaveType:leaveType.name})
   .from(leaveRequest).innerJoin(leaveType,eq(leaveType.id,leaveRequest.leaveTypeId))
   .where(and(eq(leaveRequest.tenantId,ctx.tenantId),inArray(leaveRequest.id,tasks.map(task=>task.leaveRequestId))));
  const byId=new Map(rows.map(row=>[row.id,row]));
  const choices=tasks.flatMap(task=>{const row=byId.get(task.leaveRequestId);if(!row)return[];
   return[Object.freeze({id:task.leaveRequestId,currentStepId:task.currentStepId,applicant:task.applicantLabel??'',leaveType:String(row.leaveType),days:row.days,
    startDate:String(row.startDate),endDate:String(row.endDate)})];})
   .sort((a,b)=>a.startDate.localeCompare(b.startDate)||a.applicant.localeCompare(b.applicant)||a.id.localeCompare(b.id));
  return Object.freeze({choices:Object.freeze(choices),truncated});
 });
}

/** One pending request the approver is asked to choose between: its number, the approvals queue's own labels and
 * a relative start, no handle. Disclosed under the suggested_action entity (core/semantic-model/entities-recommend.ts):
 * the applicant and dates leave as placeholders. */
export type PendingChoice=Readonly<{request:number;applicant:string;leaveType:string;days:number|null;starts:PendingStart;startDate:string;endDate:string}>;
export type PendingStart=typeof PENDING_STARTS[number];
const dayNumber=(date:string)=>Math.floor(Date.parse(date+'T00:00:00Z')/86_400_000);
/** When a request starts relative to `today`, in Monday-based weeks. Pure. */
export function pendingStarts(startDate:string,today:string):PendingStart{
 const start=dayNumber(startDate),now=dayNumber(today);
 if(!Number.isFinite(start)||start<=now)return 'started';
 // 1970-01-01 was a Thursday, index 3 of a Monday-based week (0 = Monday), so +3 aligns weeks to Mondays.
 const weekOf=(day:number)=>Math.floor((day+3)/7),weeks=weekOf(start)-weekOf(now);
 return weeks===0?'this_week':weeks===1?'next_week':weeks<=4?'in_2_to_4_weeks':'later';
}
/** The details a chat card needs; the person is asked for any of these that is missing or unclear. */
export const LEAVE_APPLY_DETAILS=['leaveType','startDate','endDate','durationType'] as const;
export type LeaveApplyDetail=typeof LEAVE_APPLY_DETAILS[number];
/** One numbered leave type from the caller's own apply menu, in the menu's fixed order. */
export type LeaveApplyOption=Readonly<{option:number;leaveType:string}>;
/** `dates` (owner, 5 November 2026: "Fix dates first"): the dates the HR date owner worked out from the person's words
 * (./request-dates.ts), with any other date those words may mean, for the tool result to state. */
export type ChatLeaveApplyOutcome=Readonly<{kind:'proposal';proposal:Proposal;dates?:RequestDates}>
 |Readonly<{kind:'ask';missing:readonly LeaveApplyDetail[];options:readonly LeaveApplyOption[];dates?:RequestDates}>;

const squash=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
/** The leave type the model named, against the caller's own menu (./leave-type-match.ts: a name in any language or a
 * code, then the kind of leave in any of the six languages, then the one name that contains it); or the number the
 * person chose from the listed options, when the person's own words this turn say that number. Unclear is null. */
function matchLeaveType(types:readonly OwnLeaveApplyType[],given:string,personWords:string|undefined):OwnLeaveApplyType|null{
 const asked=given.trim();
 if(/^\d{1,2}$/.test(asked)){const number=Number(asked);return wordsNameNumber(personWords,number)&&number>=1&&number<=types.length?types[number-1]:null;}
 const match=matchLeaveTypeWords(types,asked);
 return match.kind==='one'?match.type:null;
}
const optionsFor=(types:readonly OwnLeaveApplyType[]):readonly LeaveApplyOption[]=>Object.freeze(types.map((type,index)=>Object.freeze({option:index+1,leaveType:type.name.slice(0,64)})));

/** A leave application from a chat turn, for the caller's own leave only. `details` is the model's suggestion
 * (leaveType, startDate or date, endDate, durationType, reason); the leave type is resolved only against the
 * caller's own apply menu, and a reason is kept only when it is the person's own words this turn. The dates are a date
 * or the person's own words for the day, worked out by the HR date owner's rule (./request-dates.ts), never by the
 * model. Missing or unclear details are asked for (with the menu numbered when the leave type is unclear), never
 * guessed. Null when the caller cannot apply here at all (the suggestion stays a pointer). Throws a pause, as the
 * owners do. */
export async function prepareChatLeaveApplyProposal(ctx:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined,locale?:string,now:Date=new Date()):Promise<ChatLeaveApplyOutcome|null>{
 const menu=await readOwnLeaveApplyMenu(ctx,locale,now);
 if(menu.kind!=='menu'||!menu.types.length)return null;
 const text=(key:string)=>typeof details[key]==='string'?(details[key] as string).trim():'';
 const missing:LeaveApplyDetail[]=[];
 const type=text('leaveType')?matchLeaveType(menu.types,text('leaveType'),personWords):null;
 if(!type)missing.push('leaveType');
 const given=text('startDate')||text('date'),settled=given?requestDates(given,text('endDate'),personWords,{now}):null;
 const dates=settled?.kind==='dates'?settled.dates:undefined;
 const start=dates?.startDate??'',end=dates?.endDate??'',duration=text('durationType')||'full_day';
 if(!isCalendarDate(start))missing.push(settled?.kind==='missing'&&settled.missing==='end'?'endDate':'startDate');
 else if(!isCalendarDate(end)||end<start||leaveApplyDaySpan(start,end)>LEAVE_APPLY_MAX_DAYS)missing.push('endDate');
 if(!isChatLeaveDuration(duration))missing.push('durationType');
 else if(duration!=='full_day'&&isCalendarDate(start)&&end!==start)missing.push('endDate');
 else if(type&&duration!=='full_day'&&!type.durations.includes(duration))missing.push('durationType');
 // Dates worked out from the person's words go back with the question, so it can name them (a leave type still to
 // choose, say); a date the person gave as a date needs no restating.
 const worked=dates&&dates.phrase!==null&&!missing.includes('startDate')&&!missing.includes('endDate')?{dates}:{};
 if(missing.length)return Object.freeze({kind:'ask' as const,missing:Object.freeze([...new Set(missing)]),options:missing.includes('leaveType')?optionsFor(menu.types):Object.freeze([]),...worked});
 const known=dates?{dates}:{};
 const chosen=type!,durationType=duration as ChatLeaveDuration;
 // Other dates the person's words may mean go on the card, which offers them; only for one day.
 const card={otherDates:start===end?dates?.others??[]:[]};
 if(durationType==='full_day'&&start===end){
  const reason=text('reason'),own=reason.length>0&&reason.length<=2000&&typeof personWords==='string'&&squash(personWords).includes(squash(reason));
  const review=await prepareLeaveApplyProposal(ctx,{nomination:{action:OWN_LEAVE_ACTION,contractVersion:OWN_LEAVE_CONTRACT_VERSION,employmentId:menu.employmentId,leaveTypeId:chosen.id,date:start,durationType:'full_day'},
   selection:{employmentId:menu.employmentId,leaveTypeId:chosen.id},humanText:own?{reason}:{}},locale,card);
  if(review.kind==='proposal')return Object.freeze({...review,...known});
 }
 const form=await prepareLeaveApplyFormProposal(ctx,{leaveTypeId:chosen.id,startDate:start,endDate:end,durationType},locale,now,card);
 return form.kind==='proposal'?Object.freeze({...form,...known}):null;
}

export type SuggestedOutcome=Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'choose';pending:readonly PendingChoice[];more:number}>
 |Extract<ChatLeaveApplyOutcome,{kind:'ask'}>|Extract<AttendanceChatOutcome<string>,{kind:'ask'}>
 /** AI v2 W2: an own claim or profile change with details missing; it carries its own note for the one question. */
 |OwnChangeAsk
 /** AI v2 W2 (slice 2): a Leave Credit request with details missing; it carries its own note. */
 |Extract<ToilChatOutcome,{kind:'ask'}>
 /** AI v2 W2 (slice 3): an assigned claim or attendance decision to choose or complete; it carries its own note. */
 |Exclude<AssignedDecideOutcome,{kind:'proposal'}>;
/** At most this many pending requests are listed; the rest are counted and left to the Approvals page. */
export const MAX_PENDING_CHOICES=10;

export async function prepareSuggestedProposal(ctx:SessionContext,action:string,details:unknown,personWords:string|undefined,now:Date=new Date(),locale?:string):Promise<SuggestedOutcome|null>{
 try{
  const given=details&&typeof details==='object'&&!Array.isArray(details)?details as Record<string,unknown>:{};
  if(action==='leave.apply')return await prepareChatLeaveApplyProposal(ctx,given,personWords,locale,now);
  // AI v2 W2: own attendance requests (./attendance-request.ts), the caller's own records only.
  if(action==='attendance.correction.request')return await prepareChatAttendanceCorrectionProposal(ctx,given,personWords,now);
  if(action==='attendance.overtime.request')return await prepareChatOvertimeRequestProposal(ctx,given,personWords,now);
  // AI v2 W2: own claims and own profile changes (core/proposals/claim-submit.ts, claim-cancel.ts, profile-change.ts).
  if(action==='claims.submit')return await prepareChatClaimSubmitProposal(ctx,given,personWords,now);
  if(action==='claims.cancel')return await prepareChatClaimCancelProposal(ctx,given);
  if(action==='ess.profile.request')return await prepareChatProfileChangeProposal(ctx,given,personWords,now);
  // AI v2 W2 (slice 2): the own Leave Credit request (./toil-request.ts).
  if(action==='toil.replacement.request')return await prepareChatToilRequestProposal(ctx,given,personWords,now);
  // AI v2 W2 (slice 3): the assigned approver's claim and attendance decisions (./assigned-decide.ts).
  if(isAssignedDecideAction(action))return await prepareChatAssignedDecisionProposal(ctx,action,given,personWords,now);
  if(action==='leave.cancel'){
   if(!ctx.personId)return null;
   const today=todayInKualaLumpur(now),date=isDate(given.startDate)?given.startDate:null;
   const own=(await listLeaveRequests(ctx,undefined,50)).filter(row=>row.personId===ctx.personId&&(row.status==='pending'||row.status==='approved')
    &&String(row.endDate)>today&&(date===null||String(row.startDate)===date));
   if(own.length!==1)return null;
   const result=await prepareLeaveCancelProposal(ctx,{leaveRequestId:own[0].id},now);
   return result.kind==='proposal'?{kind:'proposal',proposal:result.proposal}:null;
  }
  if(action==='approvals.leave.decide'){
   if(!ctx.personId||!asksToApprove(personWords))return null;
   // The model's selectors count only when the person said them: otherwise the person is asked to choose.
   const givenDate=isDate(given.startDate)?given.startDate:null,givenRequest=typeof given.request==='string'&&/^\d{1,2}$/.test(given.request)?Number(given.request):null;
   const date=givenDate!==null&&wordsNameDate(personWords,givenDate)?givenDate:null;
   const request=givenRequest!==null&&wordsNameNumber(personWords,givenRequest)?givenRequest:null;
   const {choices:all,truncated}=await assignedLeaveDecisionChoices(ctx);
   // Spec v20: nothing pending for this approver is never a card.
   if(!all.length)return decisionNoMatch('approvals.leave.decide');
   // A number the person chose picks the request at that place in the same order; the review page shows who it is.
   // Otherwise the applicant the person named (matched here against the queue's own labels, never sent anywhere), and
   // a person named whose request is not pending for this approver matches nothing: never someone else's request.
   const named=request===null?all.filter(row=>wordsNameEmployee(personWords,row.applicant)):[];
   if(request===null&&!named.length&&wordsNameSomeone(personWords))return decisionNoMatch('approvals.leave.decide');
   const pool=named.length?named:all;
   const dated=pool.filter(row=>date===null||row.startDate===date);
   if(request===null&&named.length&&date!==null&&!dated.length)return decisionNoMatch('approvals.leave.decide');
   const assigned=request!==null?(request>=1&&request<=all.length?[all[request-1]]:[]):dated;
   if(assigned.length>1){
    const today=todayInKualaLumpur(now),days=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
    // `more` counts the assigned requests not listed; when the owner itself truncated, at least one more exists.
    return Object.freeze({kind:'choose',more:Math.max(0,assigned.length-MAX_PENDING_CHOICES)+(truncated?1:0),pending:Object.freeze(assigned.slice(0,MAX_PENDING_CHOICES).map(row=>Object.freeze({
     request:all.indexOf(row)+1,applicant:row.applicant,leaveType:row.leaveType,days:days(row.days),starts:pendingStarts(row.startDate,today),
     startDate:row.startDate,endDate:row.endDate})))});
   }
   if(assigned.length!==1)return null;
   // The native gate decides again whether this caller is the one assigned; an unassigned caller gets nothing.
   const result=await prepareLeaveDecideProposal(ctx,{leaveRequestId:assigned[0].id,currentStepId:assigned[0].currentStepId,decision:'approved',rejectReason:null});
   return result.kind==='proposal'?{kind:'proposal',proposal:result.proposal}:null;
  }
  return null;
 }catch{return null;}
}
