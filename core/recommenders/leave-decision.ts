/** ADR-0170 §3.5 recommenders, step 5 — the approver recommendation for a leave decision.
 *
 * For a pending leave request assigned to the caller to decide, four native checks run as the caller:
 *  - balance_covers: the applicant's ledger balance for the type (core/read.ts listLeaveRequests, the figure the
 *    approver already sees) against the days requested, under the leave type's negative-balance rule;
 *  - own_overlap: the applicant's other approved or pending leave on the same dates (listLeaveRequestsPage, by the
 *    applicant's employment and the request's date range);
 *  - team_coverage: others the caller may see away on those dates (core/read.ts plannedAbsences, narrowed to the
 *    people with leave on those dates). No tenant
 *    coverage minimum exists yet, so only "nobody else away" passes; anyone away is unusual for a person to judge;
 *  - policy_limits: the leave type's document rule and backdating, against the request.
 * Each check carries the rule version it ran under: the leave policy version (migration 0891) where the leave
 * type's rules decide, otherwise this recommender's own version.
 *
 * The verdict is code, never the model (§3.10 rule 4), and has two values only (owner decision, 2 November
 * 2026: the AI never recommends rejecting a leave request):
 *  - recommend_approve only when all four checks pass;
 *  - needs_review otherwise: any check missing (could not be read), unusual, or failed. A failure on a rule the
 *    leave engine itself refuses on (the balance below the type's floor, an overlap with the applicant's own
 *    approved leave) is still needs_review, and `failedRules` names each failed rule with its rule version so
 *    the approver sees why.
 * There is no reject value in the type, the semantic model or the signed proposal schema.
 * The approver always decides; nothing here records a decision. A model may only word the result; the wording
 * below is a deterministic template. Every computation writes one outcome record (worker
 * `approver_recommendation`), and the approver's later choice can be appended as agreement or disagreement.
 * Runs only while the worker is switched on and the tenant is not stopped. Not imported by the production
 * Assistant. */
import {and,desc,eq,gte,inArray,lte,ne} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {employment,leaveApprovalStep,leaveRequest as leaveRequestTable,leaveType as leaveTypeTable} from '../../db/schema';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {pendingLeaveTaskMetadata} from '../../packs/leave/service';
import {workerRunGateTx} from '../agent-registry/controls';
import {newRunId,recordOutcomeFollowup,writeOutcomeRecordTx,type OutcomeCheck} from '../outcome-record/record';
import {leavePolicyVersionTx} from '../outcome-record/rule-versions';
import {listLeaveRequests,listLeaveRequestsPage,plannedAbsences} from '../read';
import {RECOMMENDATION_CHECKS,type RECOMMENDATION_RESULTS,type RECOMMENDATION_VERDICTS} from '../semantic-model/entities-recommend';

export const RECOMMENDER_VERSION='leave_decision_recommender:v1';
export const RECOMMENDER_WORKER='approver_recommendation';
export const RECOMMENDER_AGENT_IDENTITY='worker.approver_recommendation';
export type RecommendationVerdict=(typeof RECOMMENDATION_VERDICTS)[number];
export type RecommendationCheckName=(typeof RECOMMENDATION_CHECKS)[number];
export type RecommendationResult=(typeof RECOMMENDATION_RESULTS)[number];
export type RecommendationCheck=Readonly<{check:RecommendationCheckName;owner:string;ruleVersion:string|null;result:RecommendationResult;
 /** A failure the leave engine itself refuses on. It is named to the approver; it never recommends rejection. */blocking:boolean}>;
/** A failed rule, named with the version it ran under. */
export type FailedRule=Readonly<{check:RecommendationCheckName;blocking:boolean;ruleVersion:string|null}>;
export type LeaveDecisionRecommendation=Readonly<{kind:'teras.recommendation';version:1;action:'approvals.leave.decide';
 verdict:RecommendationVerdict;checks:readonly RecommendationCheck[];failedRules:readonly FailedRule[];recommenderVersion:string;recordId:string|null}>;

/** The verdict from the checks alone. Any check absent from the list counts as missing. */
export function evaluateLeaveDecision(checks:readonly RecommendationCheck[]):RecommendationVerdict{
 const byName=RECOMMENDATION_CHECKS.map(name=>checks.filter(check=>check.check===name));
 if(byName.some(rows=>rows.length!==1))return'needs_review';
 const rows=byName.map(found=>found[0]);
 return rows.every(row=>row.result==='pass')?'recommend_approve':'needs_review';
}
/** The failed rules, in check order, each with its rule version. */
export const failedRules=(checks:readonly RecommendationCheck[]):readonly FailedRule[]=>
 Object.freeze(checks.filter(check=>check.result==='fail').map(check=>Object.freeze({check:check.check,blocking:check.blocking,ruleVersion:check.ruleVersion})));

/** What the native reads returned, or null where a read could not be made. */
export type LeaveDecisionFacts=Readonly<{
 request:Readonly<{startDate:string;endDate:string;days:number;hasDocument:boolean}>;
 balanceNow:number|null;
 ownLeave:Readonly<{complete:boolean;overlappingApproved:number;overlappingPending:number}>|null;
 othersAway:number|null;
 leaveType:Readonly<{allowNegativeBalance:boolean;maxNegativeBalance:number|null;requiresDocument:boolean;mandatoryAfterDays:number|null}>|null;
 policyVersion:string|null;today:string}>;

const OWNERS={balance:'core/read.ts#listLeaveRequests',overlap:'core/read.ts#listLeaveRequestsPage',coverage:'core/read.ts#plannedAbsences',policy:'core/outcome-record/rule-versions.ts#leavePolicyVersionTx'} as const;
const row=(check:RecommendationCheckName,owner:string,ruleVersion:string|null,result:RecommendationResult,blocking=false):RecommendationCheck=>Object.freeze({check,owner,ruleVersion,result,blocking});

/** The four checks from the facts. Pure, so the boundary cases are testable without a database. */
export function leaveDecisionChecks(facts:LeaveDecisionFacts):readonly RecommendationCheck[]{
 const {request,leaveType}=facts,policy=facts.policyVersion;
 const balance=facts.balanceNow===null||!leaveType||!Number.isFinite(request.days)?row('balance_covers',OWNERS.balance,policy,'missing')
  :facts.balanceNow>=request.days?row('balance_covers',OWNERS.balance,policy,'pass')
  :leaveType.allowNegativeBalance&&(leaveType.maxNegativeBalance===null||facts.balanceNow-request.days>=-leaveType.maxNegativeBalance)
   ?row('balance_covers',OWNERS.balance,policy,'unusual')
   :row('balance_covers',OWNERS.balance,policy,'fail',true);
 const own=facts.ownLeave;
 const overlap=!own||!own.complete?row('own_overlap',OWNERS.overlap,RECOMMENDER_VERSION,'missing')
  :own.overlappingApproved>0?row('own_overlap',OWNERS.overlap,RECOMMENDER_VERSION,'fail',true)
  :own.overlappingPending>0?row('own_overlap',OWNERS.overlap,RECOMMENDER_VERSION,'unusual')
  :row('own_overlap',OWNERS.overlap,RECOMMENDER_VERSION,'pass');
 const coverage=facts.othersAway===null?row('team_coverage',OWNERS.coverage,RECOMMENDER_VERSION,'missing')
  :row('team_coverage',OWNERS.coverage,RECOMMENDER_VERSION,facts.othersAway===0?'pass':'unusual');
 let limits:RecommendationCheck;
 if(!leaveType||!policy)limits=row('policy_limits',OWNERS.policy,policy,'missing');
 else{
  const needsDocument=leaveType.requiresDocument||(leaveType.mandatoryAfterDays!==null&&request.days>leaveType.mandatoryAfterDays);
  limits=needsDocument&&!request.hasDocument?row('policy_limits',OWNERS.policy,policy,'fail')
   :request.startDate<facts.today?row('policy_limits',OWNERS.policy,policy,'unusual')
   :row('policy_limits',OWNERS.policy,policy,'pass');
 }
 return Object.freeze([balance,overlap,coverage,limits]);
}

export type RecommendationUnavailable='switched_off'|'stopped'|'not_registered'|'no_login'|'not_assigned'|'not_pending';
export type RecommendLeaveDecisionResult=Readonly<{kind:'recommendation';recommendation:LeaveDecisionRecommendation}>|Readonly<{kind:'unavailable';reason:RecommendationUnavailable}>;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const overlaps=(a:{startDate:string;endDate:string},b:{startDate:string;endDate:string})=>a.startDate<=b.endDate&&a.endDate>=b.startDate;
const READ_CAP=200;
/** How many other people on leave are enough to know team coverage is unusual; plannedAbsences loads only these. */
const AWAY_CANDIDATES=50;

/** Computes and records the recommendation for one leave request assigned to the caller. */
export async function recommendLeaveDecision(supplied:SessionContext,input:Readonly<{leaveRequestId:string}>,now:Date=new Date()):Promise<RecommendLeaveDecisionResult>{
 const ctx=capture(supplied),unavailable=(reason:RecommendationUnavailable)=>Object.freeze({kind:'unavailable' as const,reason});
 if(!ctx.userId||!ctx.personId||ctx.agent)return unavailable('no_login');
 const gate=await withTenant(ctx,tx=>workerRunGateTx(tx,ctx,RECOMMENDER_WORKER));
 if(!gate.run)return unavailable(gate.reasons.includes('not_registered')?'not_registered':gate.reasons.includes('stopped')?'stopped':'switched_off');
 const startedAt=new Date(),today=todayInKualaLumpur(now);
 // Assigned to the caller now, by the owner that fills the approvals inbox.
 const assigned=await pendingLeaveTaskMetadata(ctx);
 if(!assigned.some(item=>item.id===input.leaveRequestId))return unavailable('not_assigned');
 const [request]=await listLeaveRequests(ctx,undefined,1,{requestId:input.leaveRequestId});
 if(!request||request.status!=='pending')return unavailable('not_pending');
 const days=Number(request.days),balance=Number(request.applicantBalance);
 const reads:{tool:string;status:string;refs?:string[]}[]=[{tool:'core/read.ts#listLeaveRequests',status:'ok',refs:[request.id]}];
 let ownLeave:LeaveDecisionFacts['ownLeave']=null;
 try{
  // The applicant's own approved or pending requests on these dates, by employment and date range: never a sample
  // of everything the caller can see, so a busy approver's history cannot make this check incomplete.
  const {rows,total}=await listLeaveRequestsPage(ctx,{employmentIds:[request.employmentId],statuses:['approved','pending'],
   from:request.startDate,to:request.endDate,limit:READ_CAP,offset:0});
  const own=rows.filter(other=>other.employmentId===request.employmentId&&other.id!==request.id&&overlaps(other,request));
  const ownApproved=own.filter(other=>other.status==='approved'),ownPending=own.filter(other=>other.status==='pending');
  ownLeave={complete:total<=rows.length,overlappingApproved:ownApproved.length,overlappingPending:ownPending.length};
  reads.push({tool:OWNERS.overlap,status:'ok',refs:[...ownApproved,...ownPending].map(other=>other.id)});
 }catch{reads.push({tool:OWNERS.overlap,status:'failed'});}
 let othersAway:number|null=null;
 try{
  // Only the people with approved or pending leave on these dates are loaded into plannedAbsences, never every
  // employment the caller can see. Any one of them away makes the check unusual, so a bounded list suffices.
  const candidates=await withTenant(ctx,tx=>tx.selectDistinct({personId:employment.personId}).from(leaveRequestTable)
   .innerJoin(employment,eq(employment.id,leaveRequestTable.employmentId))
   .where(and(inArray(leaveRequestTable.status,['approved','pending']),lte(leaveRequestTable.startDate,request.endDate),gte(leaveRequestTable.endDate,request.startDate),
    ne(employment.personId,request.personId))).limit(AWAY_CANDIDATES));
  const people=candidates.length?await plannedAbsences(ctx,undefined,{from:request.startDate,to:request.endDate},undefined,{personIds:candidates.map(row=>row.personId)}):[];
  othersAway=people.filter(person=>person.id!==request.personId&&person.leaves.length>0).length;
  reads.push({tool:OWNERS.coverage,status:'ok'});
 }catch{reads.push({tool:OWNERS.coverage,status:'failed'});}
 let leaveType:LeaveDecisionFacts['leaveType']=null,policyVersion:string|null=null;
 try{
  await withTenant(ctx,async tx=>{
   const [type]=await tx.select({allowNegativeBalance:leaveTypeTable.allowNegativeBalance,maxNegativeBalance:leaveTypeTable.maxNegativeBalance,
    requiresDocument:leaveTypeTable.requiresDocument,mandatoryAfterDays:leaveTypeTable.mandatoryAfterDays}).from(leaveTypeTable).where(eq(leaveTypeTable.id,request.leaveTypeId)).limit(1);
   if(!type)return;
   const floor=type.maxNegativeBalance===null?null:Number(type.maxNegativeBalance);
   leaveType={allowNegativeBalance:type.allowNegativeBalance,maxNegativeBalance:floor!==null&&Number.isFinite(floor)?floor:null,
    requiresDocument:type.requiresDocument,mandatoryAfterDays:type.mandatoryAfterDays};
   policyVersion=await leavePolicyVersionTx(tx,request.leaveTypeId);
  });
  reads.push({tool:'core/outcome-record/rule-versions.ts#leavePolicyVersionTx',status:'ok',refs:[request.leaveTypeId]});
 }catch{leaveType=null;policyVersion=null;reads.push({tool:'core/outcome-record/rule-versions.ts#leavePolicyVersionTx',status:'failed'});}
 const checks=leaveDecisionChecks({request:{startDate:request.startDate,endDate:request.endDate,days,hasDocument:request.hasDocument===true},
  balanceNow:Number.isFinite(balance)?balance:null,ownLeave,othersAway,leaveType,policyVersion,today});
 const verdict=evaluateLeaveDecision(checks),failed=failedRules(checks);
 // The record is written only while the worker may still run: a switch-off or stop in between ends it unrecorded.
 const recordId=await withTenant(ctx,async tx=>{
  if(!(await workerRunGateTx(tx,ctx,RECOMMENDER_WORKER)).run)return null;
  const record=await writeOutcomeRecordTx(tx,ctx,{runId:newRunId(),runKind:'turn',startedAt,finishedAt:new Date(Math.max(Date.now(),startedAt.getTime())),
   authority:{kind:'person',askedByUserId:ctx.userId!},agentIdentity:RECOMMENDER_AGENT_IDENTITY,reads,
   checks:checks.map((check):OutcomeCheck=>({check:check.check,owner:check.owner,ruleVersion:check.ruleVersion,
    result:check.result==='pass'?'pass':check.result==='fail'?'fail':'needs_review'})),
   replay:{model:null,provider:null,instructionSet:RECOMMENDER_VERSION,specVersion:null,specDigest:null,toolCatalogue:null},
   outcomeKind:'suggested',outcome:{action:'approvals.leave.decide',verdict,leaveRequestId:request.id,checks:checks.map(check=>`${check.check}:${check.result}`),
    failedRules:failed.map(rule=>`${rule.check}:${rule.blocking?'blocking':'non_blocking'}`)},
   humanInvolvement:'none',notice:'not_given'});
  return record.id;
 });
 if(recordId===null)return unavailable('stopped');
 return Object.freeze({kind:'recommendation' as const,recommendation:Object.freeze({kind:'teras.recommendation' as const,version:1 as const,
  action:'approvals.leave.decide' as const,verdict,checks,failedRules:failed,recommenderVersion:RECOMMENDER_VERSION,recordId})});
}

const VERDICT_TEXT:Readonly<Record<RecommendationVerdict,string>>={recommend_approve:'Recommend approve: every check passed.',
 needs_review:'Needs your review: at least one check could not be confirmed.'};
const CHECK_TEXT:Readonly<Record<RecommendationCheckName,Readonly<Record<RecommendationResult,string>>>>={
 balance_covers:{pass:'The balance covers the days requested.',fail:'The balance does not cover the days, and the leave type does not allow going that far negative.',
  unusual:'The balance covers the days only by going negative, which the leave type allows.',missing:'The balance could not be read.'},
 own_overlap:{pass:'No other leave of the applicant overlaps these dates.',fail:'The applicant already has approved leave on some of these dates.',
  unusual:'The applicant has another pending request on some of these dates.',missing:'Other leave of the applicant could not be fully read.'},
 team_coverage:{pass:'Nobody else you can see is away on these dates.',fail:'Team coverage is below the minimum.',
  unusual:'Others you can see are away on some of these dates.',missing:'Who else is away could not be read.'},
 policy_limits:{pass:'The leave type\'s document and date rules are met.',fail:'The leave type requires a document and none is attached.',
  unusual:'The leave starts before today.',missing:'The leave type\'s rules could not be read.'},
};
/** Deterministic wording. A model may rephrase it, never change the verdict or a check. */
export function recommendationText(recommendation:Pick<LeaveDecisionRecommendation,'verdict'|'checks'>):string{
 const blocking=recommendation.checks.some(check=>check.result==='fail'&&check.blocking);
 return [VERDICT_TEXT[recommendation.verdict],...(blocking?['A leave rule would refuse this request as it stands; you decide.']:[]),
  ...recommendation.checks.map(check=>CHECK_TEXT[check.check][check.result])].join(' ');
}

/** After the approver decided on the review route: whether they followed the recommendation. Appended to the
 * recommendation's own outcome record (agreement metrics): approving after recommend_approve is accepted,
 * rejecting it is not. needs_review recommends nothing, so it records nothing. The verdict is read from the
 * record, never taken from the caller, and so is the decision:
 *  - only the approver the recommendation was computed for (the record's asker) appends, never a group
 *    administrator or anyone else who can read the record;
 *  - the decision is the native one: an approval step of the recommended request that this person decided
 *    after the recommendation was computed. A supplied decision that differs from it records nothing;
 *  - one decision per record (migration 0906 unique index): a repeat records nothing. */
export async function recordRecommendationDecision(supplied:SessionContext,input:Readonly<{recordId:string;decision:'approved'|'rejected'}>):Promise<Readonly<{id:string}>|null>{
 const ctx=capture(supplied);
 if(input.decision!=='approved'&&input.decision!=='rejected')return null;
 if(!ctx.userId||!ctx.personId||ctx.agent||typeof input.recordId!=='string')return null;
 const bound=await withTenant(ctx,async tx=>{
  const [record]=await tx.select({outcome:terasOutcomeRecord.outcome,agentIdentity:terasOutcomeRecord.agentIdentity,askedByUserId:terasOutcomeRecord.askedByUserId,
   startedAt:terasOutcomeRecord.startedAt}).from(terasOutcomeRecord)
   .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasOutcomeRecord.id,input.recordId))).limit(1);
  if(!record||record.agentIdentity!==RECOMMENDER_AGENT_IDENTITY||record.askedByUserId!==ctx.userId)return null;
  const outcome=record.outcome as {verdict?:unknown;leaveRequestId?:unknown};
  if(outcome.verdict!=='recommend_approve'||typeof outcome.leaveRequestId!=='string')return null;
  // The native decision: a step of that request decided by one of this person's employments since the recommendation.
  const [step]=await tx.select({status:leaveApprovalStep.status}).from(leaveApprovalStep)
   .innerJoin(employment,eq(employment.id,leaveApprovalStep.decidedByEmploymentId))
   .where(and(eq(leaveApprovalStep.tenantId,ctx.tenantId),eq(leaveApprovalStep.leaveRequestId,outcome.leaveRequestId),
    inArray(leaveApprovalStep.status,['approved','rejected']),eq(employment.personId,ctx.personId!),gte(leaveApprovalStep.decidedAt,record.startedAt)))
   .orderBy(desc(leaveApprovalStep.decidedAt)).limit(1);
  if(!step||(step.status!=='approved'&&step.status!=='rejected'))return null;
  const [existing]=await tx.select({id:terasOutcomeFollowup.id}).from(terasOutcomeFollowup)
   .where(and(eq(terasOutcomeFollowup.tenantId,ctx.tenantId),eq(terasOutcomeFollowup.recordId,input.recordId),eq(terasOutcomeFollowup.kind,'decision'))).limit(1);
  if(existing)return null;
  return{decision:step.status as 'approved'|'rejected',leaveRequestId:outcome.leaveRequestId};
 });
 if(!bound||bound.decision!==input.decision)return null;
 const followed=bound.decision==='approved';
 // A concurrent append loses on the unique index and records nothing.
 return recordOutcomeFollowup(ctx,{kind:'decision',recordId:input.recordId,decision:followed?'accepted':'rejected',humanInvolvement:'decided',
  reference:{decision:bound.decision}}).catch(error=>{if(uniqueViolation(error))return null;throw error;});
}
function uniqueViolation(error:unknown):boolean{
 let cur=error as {code?:string;cause?:unknown}|null|undefined;
 for(let i=0;cur&&i<4;i++){if(cur.code==='23505')return true;cur=cur.cause as {code?:string;cause?:unknown}|null|undefined;}
 return false;
}
