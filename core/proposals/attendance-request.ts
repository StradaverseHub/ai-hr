/** AI v2 Phase 1 W2 — an attendance correction and an overtime request prepared from chat, as signed proposals over
 * the existing own-review stores ("do, don't point").
 *
 * The model only nominates: a date (YYYY-MM-DD, today taken from the Asia/Kuala_Lumpur HR date owner), clock times or
 * an overtime window (HH:MM, 24-hour) and, at most, the person's own reason. Everything else comes from the caller's own
 * records and the owning services, and nothing here writes an attendance request:
 *  - attendance.correction.request: the caller's own attendance day (packs/attendance/service attendanceForEmploymentRange,
 *    classified by the Attendance Request screen's own classifier) supplies what is on record; a clock-out the person
 *    names is paired with the clock-in on record (the service never takes a clock-out on its own), and a missing clock-in
 *    is asked for, never invented. The existing correction review store then runs the attendance service's own
 *    preparation as the caller (times, future dates, a request already waiting, the approval route of ADR-0121) and saves
 *    the sealed review; only a prepared review issues a proposal;
 *  - attendance.overtime.request: the overtime review store runs the same preparation as the Plan Overtime form. The
 *    minutes on the card are the service's own count of the window. No pay, rate or eligibility figure is computed here.
 * Missing or unclear details are returned for one question. A reason counts only when it is the person's own words this
 * turn; it stays in the sealed review and never reaches the proposal. Confirm and Edit:
 * core/assistant-actions/attendance-request-proposal-confirm.ts. */
import type {SessionContext} from '../../db/client';
import {myEmployment} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {attendanceForEmploymentRange,classifyDay,KIND_OF_SECTION} from '../../packs/attendance/service';
import {prepareAttendanceCorrectionReview} from '../assistant-actions/attendance-correction-review-store';
import {overtimeRequestReviews} from '../assistant-actions/overtime-request-review-store';
import {ATTENDANCE_CORRECTION_REVIEW_ACTION} from '../../lib/assistant-actions/attendance-correction-review-contract';
import {OWN_OVERTIME_REQUEST_ACTION} from '../../lib/assistant-actions/own-overtime-request-contract';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {assertProposalsConfigured,issueProposal,verifyProposal,type Proposal,type ProposalFacts,type ProposalRefusal} from './proposal';

export const ATTENDANCE_CORRECTION_ACTION=ATTENDANCE_CORRECTION_REVIEW_ACTION;
export const ATTENDANCE_OVERTIME_ACTION=OWN_OVERTIME_REQUEST_ACTION;
const CONTRACT_VERSION=1 as const;
/** The review page and its two flows (app/assistant/attendance/page.tsx). */
export const ATTENDANCE_REVIEW_ROUTE='/assistant/attendance' as const;
/** The existing forms Edit opens: the person's own attendance day, and Plan Overtime. */
export const ATTENDANCE_DAY_FORM_ROUTE='/attendance/my-records' as const;
export const OVERTIME_FORM_ROUTE='/attendance/plan-ot/apply' as const;

const declared=(id:string)=>SEMANTIC_ACTIONS.find(action=>action.id===id)!;
const passed=(id:string)=>declared(id).checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const}));
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
/** A real calendar date, YYYY-MM-DD. */
const isDate=(value:unknown):value is string=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=new Date(value+'T00:00:00.000Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};
/** HH:MM from a stored clock value (HH:MM:SS), or null. */
const hhmm=(value:string|null|undefined)=>typeof value==='string'&&/^\d{2}:\d{2}/.test(value)?value.slice(0,5):null;
const squash=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
/** The model's reason, only when it is the person's own words this turn (as leave.apply keeps one). */
export function ownReason(given:unknown,personWords:string|undefined):string|null{
 const reason=typeof given==='string'?given.trim():'';
 return reason.length>0&&reason.length<=500&&typeof personWords==='string'&&squash(personWords).includes(squash(reason))?reason:null;
}
const text=(details:Readonly<Record<string,unknown>>,...keys:string[])=>{for(const key of keys){const value=details[key];if(typeof value==='string'&&value.trim())return value.trim();}return '';};
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

/** What the person asks to correct: which clock, as a card selector. */
export type ClockCorrected='check_in'|'check_out'|'both';
export const ATTENDANCE_CORRECTION_DETAILS=['date','time','checkIn','reason'] as const;
export type AttendanceCorrectionDetail=typeof ATTENDANCE_CORRECTION_DETAILS[number];
export const OVERTIME_REQUEST_DETAILS=['date','plannedStartTime','plannedEndTime','reason'] as const;
export type OvertimeRequestDetail=typeof OVERTIME_REQUEST_DETAILS[number];
export type AttendanceChatOutcome<D extends string>=Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'ask';missing:readonly D[];options:readonly never[]}>;
const ask=<D extends string>(missing:D[])=>Object.freeze({kind:'ask' as const,missing:Object.freeze([...new Set(missing)]),options:Object.freeze([]) as readonly never[]});

/** A correction of the caller's own attendance day from a chat turn. `details`: date, checkIn and/or checkOut (HH:MM),
 * reason. Null when the caller has no own employment here or the attendance service refuses it (the suggestion then
 * stays a pointer to the review page). Never throws. */
export async function prepareChatAttendanceCorrectionProposal(supplied:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined,now:Date=new Date()):Promise<AttendanceChatOutcome<AttendanceCorrectionDetail>|null>{
 const ctx=capture(supplied);
 try{
  const userId=ctx.userId,personId=ctx.personId;if(!userId||!personId)return null;
  const own=await myEmployment(ctx);if(!own)return null;
  const date=text(details,'date','startDate'),givenIn=text(details,'checkIn','clockIn'),givenOut=text(details,'checkOut','clockOut');
  const missing:AttendanceCorrectionDetail[]=[];
  // Today is the HR date owner's Kuala Lumpur day; the attendance service refuses a future day as well.
  if(!isDate(date)||date>todayInKualaLumpur(now))missing.push('date');
  const checkInGiven=isClock(givenIn)?givenIn:null,checkOutGiven=isClock(givenOut)?givenOut:null;
  if(!checkInGiven&&!checkOutGiven)missing.push('time');
  const reason=ownReason(details.reason,personWords);
  if(!reason)missing.push('reason');
  if(missing.includes('date'))return ask(missing);
  // The person's real attendance day, as the caller, under row-level security.
  const [day]=await attendanceForEmploymentRange(ctx,own.employmentId,date,date);
  const recordedIn=hhmm(day?.checkInAt),recordedOut=hhmm(day?.checkOutAt);
  const checkIn=checkInGiven??recordedIn,checkOut=checkOutGiven??recordedOut;
  // A clock-out needs its clock-in: the one on record, or the person's own. Never one from the roster.
  if(checkOutGiven&&!checkIn)missing.push('checkIn');
  if(missing.length)return ask(missing);
  const flagged=day?classifyDay(day):null;
  assertProposalsConfigured();
  const prepared=await prepareAttendanceCorrectionReview(ctx,{action:ATTENDANCE_CORRECTION_ACTION,contractVersion:CONTRACT_VERSION,
   intent:{version:1,employmentId:own.employmentId,date,checkIn,checkOut,reason,requestKind:flagged?KIND_OF_SECTION[flagged.section]:'other'}});
  const review=prepared.review,request=review.review.request,beforeIn=hhmm(review.review.before.checkIn),beforeOut=hhmm(review.review.before.checkOut);
  if(request.employmentId!==own.employmentId||request.date!==date)return null;
  const corrects:ClockCorrected=checkInGiven&&checkOutGiven?'both':checkOutGiven?'check_out':'check_in';
  const facts:ProposalFacts={startDate:date,endDate:date,...(request.checkIn?{checkIn:request.checkIn.slice(0,5)}:{}),...(request.checkOut?{checkOut:request.checkOut.slice(0,5)}:{}),
   // What is on record, as the attendance service itself read the day for this review.
   ...(beforeIn?{recordedCheckIn:beforeIn}:{}),...(beforeOut?{recordedCheckOut:beforeOut}:{}),outcome:'submitted_not_approved'};
  const action=declared(ATTENDANCE_CORRECTION_ACTION);
  return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
   what:{action:ATTENDANCE_CORRECTION_ACTION,contractVersion:CONTRACT_VERSION,entity:action.entity,effect:action.effect,
    selectors:{date,corrects,...(checkInGiven?{checkIn:checkInGiven}:{}),...(checkOutGiven?{checkOut:checkOutGiven}:{})},reviewedDigest:review.reviewedDigest},
   forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:own.employmentId},
   authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
   checks:passed(ATTENDANCE_CORRECTION_ACTION),
   review:{route:ATTENDANCE_REVIEW_ROUTE,href:`${ATTENDANCE_REVIEW_ROUTE}?review=${review.actionId}`,reference:review.actionId},
   facts,createdAt:review.createdAt,expiresAt:review.expiresAt})});
 }catch{return null;}
}

/** An overtime request for the caller's own employment from a chat turn. `details`: date, plannedStartTime and
 * plannedEndTime (HH:MM; an earlier end is the next day, as the Plan Overtime form reads it), reason. Null when the caller
 * cannot request overtime here or the attendance service refuses it. Never throws. */
export async function prepareChatOvertimeRequestProposal(supplied:SessionContext,details:Readonly<Record<string,unknown>>,personWords:string|undefined):Promise<AttendanceChatOutcome<OvertimeRequestDetail>|null>{
 const ctx=capture(supplied);
 try{
  const userId=ctx.userId,personId=ctx.personId;if(!userId||!personId)return null;
  const own=await myEmployment(ctx);if(!own)return null;
  const date=text(details,'date','startDate'),start=text(details,'plannedStartTime','startTime','start'),end=text(details,'plannedEndTime','endTime','end');
  const missing:OvertimeRequestDetail[]=[];
  if(!isDate(date))missing.push('date');
  if(!isClock(start))missing.push('plannedStartTime');
  if(!isClock(end)||end===start)missing.push('plannedEndTime');
  const reason=ownReason(details.reason,personWords);
  if(!reason)missing.push('reason');
  if(missing.length)return ask(missing);
  assertProposalsConfigured();
  const prepared=await overtimeRequestReviews.prepare(ctx,{action:ATTENDANCE_OVERTIME_ACTION,contractVersion:CONTRACT_VERSION,employmentId:own.employmentId,date,plannedStartTime:start,plannedEndTime:end,reason});
  if(prepared.kind!=='prepared')return null;
  const review=prepared.review,native=review.review;
  if(native.employmentId!==own.employmentId||native.date!==date)return null;
  const action=declared(ATTENDANCE_OVERTIME_ACTION);
  return Object.freeze({kind:'proposal' as const,proposal:issueProposal({
   what:{action:ATTENDANCE_OVERTIME_ACTION,contractVersion:CONTRACT_VERSION,entity:action.entity,effect:action.effect,
    selectors:{date,plannedStartTime:native.plannedStartTime,plannedEndTime:native.plannedEndTime},reviewedDigest:review.reviewedDigest},
   forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:own.employmentId},
   authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
   checks:passed(ATTENDANCE_OVERTIME_ACTION),
   review:{route:ATTENDANCE_REVIEW_ROUTE,href:`${ATTENDANCE_REVIEW_ROUTE}?flow=overtime&review=${review.actionId}`,reference:review.actionId},
   facts:{startDate:date,endDate:date,plannedStart:native.plannedStartTime,plannedEnd:native.plannedEndTime,overtimeMinutes:native.requestedOtMinutes,outcome:'submitted_not_approved'},
   createdAt:review.createdAt,expiresAt:review.expiresAt})});
 }catch{return null;}
}

export type AttendanceProposalRefusal=ProposalRefusal|'wrong_action';
/** The custody confirmation a verified proposal names, for the current caller only. */
export function attendanceReviewConfirmation(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;action:typeof ATTENDANCE_CORRECTION_ACTION|typeof ATTENDANCE_OVERTIME_ACTION;
 confirmation:Readonly<{action:string;contractVersion:1;actionId:string;reviewedDigest:string}>;employmentId:string}>|Readonly<{ok:false;reason:AttendanceProposalRefusal}>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review,forWhom}=verified.proposal.body;
 const action=what.action===ATTENDANCE_CORRECTION_ACTION||what.action===ATTENDANCE_OVERTIME_ACTION?what.action:null;
 if(!action||what.contractVersion!==CONTRACT_VERSION||review.route!==ATTENDANCE_REVIEW_ROUTE||forWhom.subject!=='own_employment')return{ok:false,reason:'wrong_action'};
 return{ok:true,action,employmentId:forWhom.subjectId,confirmation:Object.freeze({action,contractVersion:CONTRACT_VERSION,actionId:review.reference,reviewedDigest:what.reviewedDigest})};
}

export type AttendanceEditResult=Readonly<{ok:true;href:string}>|Readonly<{ok:false;reason:AttendanceProposalRefusal|'unavailable'}>;
/** Edit: the existing form, opened on the card's own selectors and validated again server-side as the caller — the
 * proposal's employment must still be the caller's current own employment, and the date and times well formed (a
 * correction day not in the future). A correction opens the person's own attendance day with the times they asked for;
 * an overtime request opens Plan Overtime on its date and window. The link only seeds the form: its own checks and the
 * attendance service decide when the person submits. No reason or other free text is ever put in the link. */
export async function attendanceEditHref(caller:SessionContext,value:unknown,now:Date=new Date()):Promise<AttendanceEditResult>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review,forWhom}=verified.proposal.body,selectors=what.selectors;
 if((what.action!==ATTENDANCE_CORRECTION_ACTION&&what.action!==ATTENDANCE_OVERTIME_ACTION)||review.route!==ATTENDANCE_REVIEW_ROUTE||forWhom.subject!=='own_employment')return{ok:false,reason:'wrong_action'};
 let own:Awaited<ReturnType<typeof myEmployment>>;
 try{own=await myEmployment(capture(caller));}catch{return{ok:false,reason:'unavailable'};}
 if(!own||own.employmentId!==forWhom.subjectId||!isDate(selectors.date))return{ok:false,reason:'unavailable'};
 if(what.action===ATTENDANCE_CORRECTION_ACTION){
  const checkIn=selectors.checkIn,checkOut=selectors.checkOut;
  if(selectors.date>todayInKualaLumpur(now)||(checkIn!==undefined&&!isClock(checkIn))||(checkOut!==undefined&&!isClock(checkOut))||(checkIn===undefined&&checkOut===undefined))return{ok:false,reason:'unavailable'};
  const query=new URLSearchParams({...(checkIn?{checkIn}:{}),...(checkOut?{checkOut}:{})});
  return{ok:true,href:`${ATTENDANCE_DAY_FORM_ROUTE}/${selectors.date}?${query.toString()}`};
 }
 const start=selectors.plannedStartTime,end=selectors.plannedEndTime;
 if(!isClock(start)||!isClock(end)||start===end)return{ok:false,reason:'unavailable'};
 return{ok:true,href:OVERTIME_FORM_ROUTE+'?'+new URLSearchParams({date:selectors.date,start,end}).toString()};
}
