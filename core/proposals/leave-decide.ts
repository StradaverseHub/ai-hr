/** ADR-0170 step 2 — `approvals.leave.decide` as a signed proposal object, over the existing assigned review.
 *
 * Prepare: the assigned leave decision review (core/assistant-actions/leave-decision-review-store.ts) runs as
 * the caller. Its native source (reviewed-leave-decision-source.ts -> core/leave.ts
 * lockReviewedLeaveDecisionSourceTx) checks the AI controls and the Assistant action guard, that the request is
 * still pending, that the named step is its CURRENT step, and that the caller may decide it now through the
 * same per-step gate the Approvals page uses (assertCanDecideLeaveStep / assertCanDecide): the self-approval
 * ban, the assigned approver kind, and the delegations those gates admit. Only a prepared review issues a
 * proposal, carrying that review's digest, expiry and custody handle.
 * The decision is the person's own (approve, or reject with their reason); a model never supplies it.
 * Key facts come from native reads as the caller: the request as listLeaveRequests projects it to the
 * approver (applicant's current balance), and plannedAbsences for who else is away on those dates.
 * Confirm: the existing review command (POST /api/assistant/module-actions, page /assistant/approvals) under
 * the approver's own login. Nothing here records a decision. Not imported by the production Assistant. */
import {type SessionContext} from '../../db/client';
import {listLeaveRequests,plannedAbsences} from '../read';
import {prepareLeaveDecisionReview} from '../assistant-actions/leave-decision-review-store';
import {REVIEWED_LEAVE_DECISION_ACTION} from '../../lib/assistant-actions/reviewed-leave-decision-contract';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {assertProposalsConfigured,issueProposal,verifyProposal,type Proposal,type ProposalFacts,type ProposalRefusal} from './proposal';

const declared=SEMANTIC_ACTIONS.find(action=>action.id===REVIEWED_LEAVE_DECISION_ACTION)!;
const passedChecks=()=>declared.checks.map(check=>({check:check.check,owner:check.owner,ruleVersion:null,result:'pass' as const}));
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

/** The person's own selection on the approvals queue and their own decision. */
export type LeaveDecideHumanInput=Readonly<{leaveRequestId:string;currentStepId:string|null;decision:'approved'|'rejected';rejectReason:string|null}>;
export type LeaveDecideProposalResult=Readonly<{kind:'proposal';proposal:Proposal}>|Readonly<{kind:'unavailable'}>;
export async function prepareLeaveDecideProposal(supplied:SessionContext,input:LeaveDecideHumanInput):Promise<LeaveDecideProposalResult>{
 const ctx=capture(supplied),unavailable=Object.freeze({kind:'unavailable' as const}),personId=ctx.personId,userId=ctx.userId;
 assertProposalsConfigured();
 if(!personId||!userId)return unavailable;
 let prepared:Awaited<ReturnType<typeof prepareLeaveDecisionReview>>;
 try{prepared=await prepareLeaveDecisionReview(ctx,{action:REVIEWED_LEAVE_DECISION_ACTION,contractVersion:1,leaveRequestId:input.leaveRequestId,
  currentStepId:input.currentStepId,decision:input.decision,rejectReason:input.rejectReason,confirmAssignedDecision:true});}catch{return unavailable;}
 if(prepared.kind!=='prepared')return unavailable;
 const review=prepared.review,request=review.review;
 if(request.leaveRequestId!==input.leaveRequestId||request.currentStepId!==input.currentStepId||request.decision!==input.decision)return unavailable;
 const days=Number(request.days);if(!Number.isFinite(days))return unavailable;
 const facts:ProposalFacts={leaveType:request.leaveTypeName.slice(0,64),startDate:request.startDate,endDate:request.endDate,days,decision:request.decision,outcome:request.outcome};
 // Approver context is shown when the caller's own reads return it; a read the caller cannot make adds nothing.
 try{const [row]=await listLeaveRequests(ctx,undefined,1,{requestId:request.leaveRequestId});
  const balance=Number(row?.applicantBalance);
  if(row&&Number.isFinite(balance))facts.balanceNow=balance;
  if(row){const people=await plannedAbsences(ctx,undefined,{from:request.startDate,to:request.endDate});
   facts.othersAway=people.filter(person=>person.personId!==row.personId&&person.leaves.length>0).length;}
 }catch{/* context is optional; the review route still shows the request */}
 return Object.freeze({kind:'proposal',proposal:issueProposal({
  what:{action:REVIEWED_LEAVE_DECISION_ACTION,contractVersion:review.contractVersion,entity:declared.entity,effect:declared.effect,
   selectors:{startDate:request.startDate,decision:request.decision},reviewedDigest:review.reviewedDigest},
  forWhom:{tenantId:ctx.tenantId,subject:'assigned_request',subjectId:request.leaveRequestId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId,personId},
  checks:passedChecks(),
  review:{route:declared.reviewRoute,href:`${declared.reviewRoute}?review=${review.actionId}`,reference:review.actionId},
  facts,createdAt:review.createdAt,expiresAt:review.expiresAt})});
}

/** Packets the existing review command takes for a verified proposal, under the approver's own login. */
export type LeaveDecideReviewPackets=Readonly<{
 reopen:Readonly<{action:typeof REVIEWED_LEAVE_DECISION_ACTION;operation:'reopen';actionId:string}>;
 confirm:Readonly<{action:typeof REVIEWED_LEAVE_DECISION_ACTION;operation:'confirm';confirmation:Readonly<{action:typeof REVIEWED_LEAVE_DECISION_ACTION;contractVersion:1;actionId:string;reviewedDigest:string}>}>}>;
export function leaveDecideReviewPackets(value:unknown,caller:SessionContext,now:Date):Readonly<{ok:true;packets:LeaveDecideReviewPackets}>|Readonly<{ok:false;reason:ProposalRefusal|'wrong_action'}>{
 const verified=verifyProposal(value,caller,now);
 if(!verified.ok)return verified;
 const {what,review}=verified.proposal.body;
 if(what.action!==REVIEWED_LEAVE_DECISION_ACTION||what.contractVersion!==1||review.route!==declared.reviewRoute)return{ok:false,reason:'wrong_action'};
 return{ok:true,packets:Object.freeze({reopen:Object.freeze({action:REVIEWED_LEAVE_DECISION_ACTION,operation:'reopen' as const,actionId:review.reference}),
  confirm:Object.freeze({action:REVIEWED_LEAVE_DECISION_ACTION,operation:'confirm' as const,
   confirmation:Object.freeze({action:REVIEWED_LEAVE_DECISION_ACTION,contractVersion:1 as const,actionId:review.reference,reviewedDigest:what.reviewedDigest})})})};
}
