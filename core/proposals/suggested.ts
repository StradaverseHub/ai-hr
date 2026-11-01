/** ADR-0170 step 2 — the proposal a harness turn issues when the model suggests a leave card action.
 *
 * The model only points: its suggestion names an action and, at most, the typed selectors the semantic model
 * declares nominable (a date). Everything else comes from the caller's own records and the person's own words,
 * and the native preparer decides:
 *  - leave.cancel: the caller's one own pending or approved request starting on the nominated date (or their
 *    only one, when no date is given). Ambiguity issues nothing; the review page asks.
 *  - approvals.leave.decide: the one request currently assigned to the caller, and only when the person's own
 *    words ask to approve it (a negation such as "do not approve" or "jangan lulus" never does). The requests
 *    come from the native assigned-choice owner (core/leave.ts pendingLeaveDecisionChoiceMetadataTx, through
 *    assignedLeaveDecisionChoices below), never from what the caller can merely see. With several assigned (or
 *    several on the nominated date), nothing is prepared: they are returned, numbered in a fixed order, for the
 *    model to list, and it asks which one (ADR-0170 §3.15). It never picks one. The person answers with a number
 *    (`request` in details), which picks the request at that place in the same order now. A number or date the
 *    model passes counts only when the person's own words this turn contain it; otherwise it is ignored and the
 *    person is asked. A rejection needs the person's own reason, so it is never prepared here.
 *  - leave.apply: not prepared from a turn. It needs the person's leave type selection and their own text,
 *    which only the review page collects; the suggestion stays a pointer.
 * Returns null when neither a proposal nor a choice is issued; never throws. */
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {leaveRequest,leaveType} from '../../db/schema';
import {pendingLeaveDecisionChoiceMetadataTx} from '../../packs/leave/service';
import {listLeaveRequests} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {prepareLeaveCancelProposal} from './leave-cancel';
import {prepareLeaveDecideProposal} from './leave-decide';
import type {Proposal} from './proposal';
import {PENDING_STARTS} from '../semantic-model/entities-recommend';

const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
/** "Do not approve", "don't approve", "never approve", "not yet approve", "jangan lulus", "tak approve": a negation
 * up to two words before approve (or the Malay lulus). */
const NEGATED_APPROVE=/(?:\bdo\s+not|\bdon['\u2019]?t|\bdont|\bdid\s+not|\bdidn['\u2019]?t|\bnever|\bnot|\bjangan|\btak|\btidak|\bbelum)\s+(?:\S+\s+){0,2}?(?:approve|lulus)/i;
/** The person asks to approve, does not negate it, and does not also mention rejecting. Only the person's words are read. */
export const asksToApprove=(words:string|undefined)=>typeof words==='string'&&/\bapprove\b/i.test(words)&&!NEGATED_APPROVE.test(words)
 &&!/\b(reject|decline|deny|refuse)\b/i.test(words);

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
 return withTenant(ctx,async tx=>{
  const {tasks,truncated}=await pendingLeaveDecisionChoiceMetadataTx(tx,ctx);
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
export type SuggestedOutcome=Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'choose';pending:readonly PendingChoice[];more:number}>;
/** At most this many pending requests are listed; the rest are counted and left to the Approvals page. */
export const MAX_PENDING_CHOICES=10;

export async function prepareSuggestedProposal(ctx:SessionContext,action:string,details:unknown,personWords:string|undefined,now:Date=new Date()):Promise<SuggestedOutcome|null>{
 try{
  const given=details&&typeof details==='object'&&!Array.isArray(details)?details as Record<string,unknown>:{};
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
   // A number the person chose picks the request at that place in the same order; the review page shows who it is.
   const assigned=request!==null?(request>=1&&request<=all.length?[all[request-1]]:[]):all.filter(row=>date===null||row.startDate===date);
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
