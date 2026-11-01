/** ADR-0170 step 2 — the proposal a harness turn issues when the model suggests a leave card action.
 *
 * The model only points: its suggestion names an action and, at most, the typed selectors the semantic model
 * declares nominable (a date). Everything else comes from the caller's own records and the person's own words,
 * and the native preparer decides:
 *  - leave.cancel: the caller's one own pending or approved request starting on the nominated date (or their
 *    only one, when no date is given). Ambiguity issues nothing; the review page asks.
 *  - approvals.leave.decide: the one request currently assigned to the caller, and only when the person's own
 *    words ask to approve it. With several pending (or several on the nominated date), nothing is prepared:
 *    the pending requests are returned, numbered in a fixed order, for the model to list, and it asks which one
 *    (ADR-0170 §3.15). It never picks one. The person answers with a number (`request` in details), which picks
 *    the request at that place in the same order now. A rejection needs the person's own reason, so it is never
 *    prepared here.
 *  - leave.apply: not prepared from a turn. It needs the person's leave type selection and their own text,
 *    which only the review page collects; the suggestion stays a pointer.
 * Returns null when neither a proposal nor a choice is issued; never throws. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {listLeaveRequests} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {prepareLeaveCancelProposal} from './leave-cancel';
import {prepareLeaveDecideProposal} from './leave-decide';
import type {Proposal} from './proposal';
import {PENDING_STARTS} from '../semantic-model/entities-recommend';

const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
/** The person asks to approve, and does not also mention rejecting. Only the person's words are read. */
export const asksToApprove=(words:string|undefined)=>typeof words==='string'&&/\bapprove\b/i.test(words)&&!/\b(reject|decline|deny|refuse)\b/i.test(words);

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
   const date=isDate(given.startDate)?given.startDate:null,request=typeof given.request==='string'&&/^\d{1,2}$/.test(given.request)?Number(given.request):null;
   const all=(await listLeaveRequests(ctx,undefined,50,{status:'pending'})).filter(row=>row.personId!==ctx.personId)
    .sort((a,b)=>String(a.startDate).localeCompare(String(b.startDate))||String(a.employee).localeCompare(String(b.employee))||String(a.id).localeCompare(String(b.id)));
   // A number the person chose picks the request at that place in the same order; the review page shows who it is.
   const assigned=request!==null?(request>=1&&request<=all.length?[all[request-1]]:[]):all.filter(row=>date===null||String(row.startDate)===date);
   if(assigned.length>1){
    const today=todayInKualaLumpur(now),days=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
    return Object.freeze({kind:'choose',more:Math.max(0,assigned.length-MAX_PENDING_CHOICES),pending:Object.freeze(assigned.slice(0,MAX_PENDING_CHOICES).map(row=>Object.freeze({
     request:all.indexOf(row)+1,applicant:String(row.employee),leaveType:String(row.leaveType),days:days(row.days),starts:pendingStarts(String(row.startDate),today),
     startDate:String(row.startDate),endDate:String(row.endDate)})))});
   }
   if(assigned.length!==1)return null;
   const [step]=await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select id from public.leave_approval_step where leave_request_id=${assigned[0].id}::uuid and tenant_id=${ctx.tenantId}::uuid and status='pending' order by step_index,id limit 1`)) as unknown as {id:string}[];
   // The native gate decides whether this caller is the one assigned; an unassigned caller gets nothing.
   const result=await prepareLeaveDecideProposal(ctx,{leaveRequestId:assigned[0].id,currentStepId:step?.id??null,decision:'approved',rejectReason:null});
   return result.kind==='proposal'?{kind:'proposal',proposal:result.proposal}:null;
  }
  return null;
 }catch{return null;}
}
