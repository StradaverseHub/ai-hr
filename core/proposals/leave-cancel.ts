/** ADR-0170 step 2 — `leave.cancel` as a signed proposal object, over the two existing cancellation paths.
 *
 * The person's own request decides which path applies; the proposal never chooses:
 *  - PENDING: the Assistant's own-leave cancellation review (core/assistant-actions/leave-change-review-store.ts)
 *    prepares as the caller, re-checking the actor, the AI controls and that the request is the caller's own
 *    plain pending request, and saves the review custody row. Confirmation is that review's own command
 *    (POST /api/assistant/module-actions, page /assistant/leave) under the person's login; the native service
 *    withdraws the request at once.
 *  - APPROVED: there is no Assistant review route for giving back approved leave. The card points to the
 *    existing native path, the Cancel dates dialog on /leave (requestLeaveCancellationAction ->
 *    requestLeaveCancellation), which re-runs every gate and creates a cancellation request that goes through
 *    its normal approval. A leave type set to approve give-backs automatically would change the balance at
 *    once, so no card is issued for it (Orchestrator condition, 1 November 2026). The dates offered are the native offer
 *    (core/read.ts employeeCancelOffers), the same predicate the /leave button uses. No custody row exists, so
 *    the proposal's digest binds what the card showed but the /leave form does not check it; the person
 *    re-selects the dates there.
 * Inputs come from the person's own selection (a request, optional dates), never from a model. Nothing here
 * writes leave. Not imported by the production Assistant. */
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {employeeCancelOffers,listLeaveRequests} from '../read';
import {cancelApprovedSettingOf,cancelApprovedTypeColumns} from '../leave';
import {leaveType as leaveTypeTable} from '../../db/schema';
import {readOwnLeaveActorTx} from '../assistant-actions/own-leave-actor';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {leaveCancellationReviews} from '../assistant-actions/leave-change-review-store';
import {OWN_LEAVE_CANCELLATION_ACTION} from '../../lib/assistant-actions/own-leave-change-contract';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {assertProposalsConfigured,canonicalJson,issueProposal,verifyProposal,type Proposal,type ProposalRefusal} from './proposal';

const declared=SEMANTIC_ACTIONS.find(action=>action.id===OWN_LEAVE_CANCELLATION_ACTION)!;
/** The native path for approved leave, and how long its card stays open (the custody reviews' own ten minutes). */
export const APPROVED_LEAVE_CANCEL_ROUTE='/leave' as const;
const APPROVED_TTL_MS=600_000;
const VARIANT_CHECKS={pending:['ai_controls_unpaused','own_pending_request'],approved:['actor_current','ai_controls_unpaused','own_approved_cancellable']} as const;
const passedChecks=(variant:keyof typeof VARIANT_CHECKS)=>VARIANT_CHECKS[variant].map(name=>{const check=declared.checks.find(row=>row.check===name)!;
 return{check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const};});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);

export type LeaveCancelProposalResult=Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'unavailable'}>;
/** `cancelDates` applies to approved leave only; omitted, every date the native offer allows is proposed. */
export async function prepareLeaveCancelProposal(supplied:SessionContext,input:Readonly<{leaveRequestId:unknown;cancelDates?:unknown}>,now:Date=new Date()):Promise<LeaveCancelProposalResult>{
 const ctx=capture(supplied),unavailable=Object.freeze({kind:'unavailable' as const});
 assertProposalsConfigured();
 const personId=ctx.personId,userId=ctx.userId,id=input.leaveRequestId;
 if(!personId||!userId||typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return unavailable;
 let row:Awaited<ReturnType<typeof listLeaveRequests>>[number]|undefined;
 try{[row]=await listLeaveRequests(ctx,undefined,1,{requestId:id});}catch{return unavailable;}
 // RLS lets a manager see a report's leave; only the person's own request is cancellable by them.
 if(!row||row.personId!==personId)return unavailable;
 const startDate=String(row.startDate),endDate=String(row.endDate),days=Number(row.days),leaveType=String(row.leaveType).slice(0,64);
 if(!Number.isFinite(days))return unavailable;

 if(row.status==='pending'){
  if(input.cancelDates!==undefined)return unavailable;
  let prepared:Awaited<ReturnType<typeof leaveCancellationReviews.prepare>>;
  try{prepared=await leaveCancellationReviews.prepare(ctx,{action:OWN_LEAVE_CANCELLATION_ACTION,contractVersion:1,employmentId:row.employmentId,leaveRequestId:id,cancel:true});}catch{return unavailable;}
  if(prepared.kind!=='prepared')return unavailable;
  const review=prepared.review;
  if(review.content.leaveRequestId!==id||review.review.employmentId!==row.employmentId)return unavailable;
  return Object.freeze({kind:'proposal',proposal:issueProposal({
   what:{action:OWN_LEAVE_CANCELLATION_ACTION,contractVersion:review.contractVersion,entity:declared.entity,effect:declared.effect,
    selectors:{startDate:review.review.startDate,requestStatus:'pending'},reviewedDigest:review.reviewedDigest},
   forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:row.employmentId},
   authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
   checks:passedChecks('pending'),
   review:{route:declared.reviewRoute,href:`${declared.reviewRoute}?review=${review.actionId}`,reference:review.actionId},
   facts:{leaveType:review.review.leaveTypeName.slice(0,64),startDate:review.review.startDate,endDate:review.review.endDate,days:review.review.days,outcome:'withdrawn_now'},
   createdAt:review.createdAt,expiresAt:review.expiresAt})});
 }

 if(row.status!=='approved')return unavailable;
 // The Assistant's own actor and AI-control checks, so a card is never issued where the Assistant is withdrawn;
 // and the leave type's own rule: only a give-back that waits for its normal approval gets a card.
 try{const allowed=await withTenant(ctx,async tx=>{const fresh=await readOwnLeaveActorTx(tx,ctx);if(!fresh)return false;await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
   const [type]=await tx.select(cancelApprovedTypeColumns).from(leaveTypeTable).where(eq(leaveTypeTable.id,row!.leaveTypeId)).limit(1);
   const setting=cancelApprovedSettingOf(type);return setting.allowed&&!setting.autoApprove;});
  if(!allowed)return unavailable;}catch{return unavailable;}
 const today=todayInKualaLumpur(now);
 let offered:readonly string[]|null|undefined;
 try{offered=(await employeeCancelOffers(ctx,[row],today)).get(row.id);}catch{return unavailable;}
 if(!offered||offered.length===0)return unavailable;
 const asked=input.cancelDates===undefined?[...offered]:Array.isArray(input.cancelDates)&&input.cancelDates.every(isDate)?[...new Set(input.cancelDates as string[])].sort():null;
 if(!asked||asked.length===0||asked.length>31||asked.some(date=>!offered!.includes(date)))return unavailable;
 const reviewedDigest=createHash('sha256').update(canonicalJson(['teras:leave-cancel-approved:v1',{tenantId:ctx.tenantId,userId,personId},
  {leaveRequestId:row.id,employmentId:row.employmentId,leaveTypeId:row.leaveTypeId,startDate,endDate,days,offered:[...offered],cancelDates:asked}])).digest('hex');
 return Object.freeze({kind:'proposal',proposal:issueProposal({
  what:{action:OWN_LEAVE_CANCELLATION_ACTION,contractVersion:1,entity:declared.entity,effect:declared.effect,
   selectors:{startDate,requestStatus:'approved'},reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'own_employment',subjectId:row.employmentId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
  checks:passedChecks('approved'),
  review:{route:APPROVED_LEAVE_CANCEL_ROUTE,href:APPROVED_LEAVE_CANCEL_ROUTE,reference:row.id},
  facts:{leaveType,startDate,endDate,days,cancelDates:asked,outcome:'give_back_requested'},
  createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+APPROVED_TTL_MS).toISOString()})});
}

/** What the person's own review step posts for a verified proposal, under their own login:
 *  pending  -> the module-actions review command (reopen, then confirm with the custody digest);
 *  approved -> the /leave Cancel dates form fields (requestLeaveCancellationAction re-runs every gate). */
export type LeaveCancelReviewPackets=Readonly<{kind:'assistant_review';
  reopen:Readonly<{action:typeof OWN_LEAVE_CANCELLATION_ACTION;operation:'reopen';actionId:string}>;
  confirm:Readonly<{action:typeof OWN_LEAVE_CANCELLATION_ACTION;operation:'confirm';confirmation:Readonly<{action:typeof OWN_LEAVE_CANCELLATION_ACTION;contractVersion:1;actionId:string;reviewedDigest:string}>}>}>
 |Readonly<{kind:'leave_form';route:typeof APPROVED_LEAVE_CANCEL_ROUTE;form:Readonly<{leaveRequestId:string;cancelDate:readonly string[]}>}>;
export function leaveCancelReviewPackets(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;packets:LeaveCancelReviewPackets}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'}>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review,facts}=verified.proposal.body;
 if(what.action!==OWN_LEAVE_CANCELLATION_ACTION||what.contractVersion!==1)return{ok:false,reason:'wrong_action'};
 if(what.selectors.requestStatus==='pending'&&review.route===declared.reviewRoute)
  return{ok:true,packets:Object.freeze({kind:'assistant_review' as const,
   reopen:Object.freeze({action:OWN_LEAVE_CANCELLATION_ACTION,operation:'reopen' as const,actionId:review.reference}),
   confirm:Object.freeze({action:OWN_LEAVE_CANCELLATION_ACTION,operation:'confirm' as const,
    confirmation:Object.freeze({action:OWN_LEAVE_CANCELLATION_ACTION,contractVersion:1 as const,actionId:review.reference,reviewedDigest:what.reviewedDigest})})})};
 if(what.selectors.requestStatus==='approved'&&review.route===APPROVED_LEAVE_CANCEL_ROUTE&&facts?.cancelDates)
  return{ok:true,packets:Object.freeze({kind:'leave_form' as const,route:APPROVED_LEAVE_CANCEL_ROUTE,form:Object.freeze({leaveRequestId:review.reference,cancelDate:Object.freeze([...facts.cancelDates])})})};
 return{ok:false,reason:'wrong_action'};
}
