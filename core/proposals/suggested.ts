/** ADR-0170 step 2 — the proposal a harness turn issues when the model suggests a leave card action.
 *
 * The model only points: its suggestion names an action and, at most, the typed selectors the semantic model
 * declares nominable (a date). Everything else comes from the caller's own records and the person's own words,
 * and the native preparer decides:
 *  - leave.cancel: the caller's one own pending or approved request starting on the nominated date (or their
 *    only one, when no date is given). Ambiguity issues nothing; the review page asks.
 *  - approvals.leave.decide: the one request currently assigned to the caller, and only when the person's own
 *    words ask to approve it. A rejection needs the person's own reason, so it is never prepared here.
 *  - leave.apply: not prepared from a turn. It needs the person's leave type selection and their own text,
 *    which only the review page collects; the suggestion stays a pointer.
 * Returns null whenever no proposal is issued; never throws. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {listLeaveRequests} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {prepareLeaveCancelProposal} from './leave-cancel';
import {prepareLeaveDecideProposal} from './leave-decide';
import type {Proposal} from './proposal';

const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
/** The person asks to approve, and does not also mention rejecting. Only the person's words are read. */
export const asksToApprove=(words:string|undefined)=>typeof words==='string'&&/\bapprove\b/i.test(words)&&!/\b(reject|decline|deny|refuse)\b/i.test(words);

export async function prepareSuggestedProposal(ctx:SessionContext,action:string,details:unknown,personWords:string|undefined,now:Date=new Date()):Promise<Proposal|null>{
 try{
  const given=details&&typeof details==='object'&&!Array.isArray(details)?details as Record<string,unknown>:{};
  if(action==='leave.cancel'){
   if(!ctx.personId)return null;
   const today=todayInKualaLumpur(now),date=isDate(given.startDate)?given.startDate:null;
   const own=(await listLeaveRequests(ctx,undefined,50)).filter(row=>row.personId===ctx.personId&&(row.status==='pending'||row.status==='approved')
    &&String(row.endDate)>today&&(date===null||String(row.startDate)===date));
   if(own.length!==1)return null;
   const result=await prepareLeaveCancelProposal(ctx,{leaveRequestId:own[0].id},now);
   return result.kind==='proposal'?result.proposal:null;
  }
  if(action==='approvals.leave.decide'){
   if(!ctx.personId||!asksToApprove(personWords))return null;
   const date=isDate(given.startDate)?given.startDate:null;
   const assigned=(await listLeaveRequests(ctx,undefined,50,{status:'pending'})).filter(row=>row.personId!==ctx.personId&&(date===null||String(row.startDate)===date));
   if(assigned.length!==1)return null;
   const [step]=await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select id from public.leave_approval_step where leave_request_id=${assigned[0].id}::uuid and tenant_id=${ctx.tenantId}::uuid and status='pending' order by step_index,id limit 1`)) as unknown as {id:string}[];
   // The native gate decides whether this caller is the one assigned; an unassigned caller gets nothing.
   const result=await prepareLeaveDecideProposal(ctx,{leaveRequestId:assigned[0].id,currentStepId:step?.id??null,decision:'approved',rejectReason:null});
   return result.kind==='proposal'?result.proposal:null;
  }
  return null;
 }catch{return null;}
}
