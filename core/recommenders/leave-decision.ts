/** ADR-0170 §3.5 recommenders, step 5 — the approver recommendation for a leave decision.
 *
 * For a pending leave request assigned to the caller to decide, four native checks run as the caller:
 *  - balance_covers: the applicant's ledger balance for the type (core/read.ts listLeaveRequests, the figure the
 *    approver already sees) against the days requested, under the leave type's negative-balance rule;
 *  - own_overlap: the applicant's other approved or pending leave on the same dates (listLeaveRequests);
 *  - team_coverage: others the caller may see away on those dates (core/read.ts plannedAbsences). No tenant
 *    coverage minimum exists yet, so only "nobody else away" passes; anyone away is unusual for a person to judge;
 *  - policy_limits: the leave type's document rule and backdating, against the request.
 * Each check carries the rule version it ran under: the leave policy version (migration 0891) where the leave
 * type's rules decide, otherwise this recommender's own version.
 *
 * The verdict is code, never the model (§3.10 rule 4):
 *  - needs_review is the default: any check missing (could not be read), unusual, or failed without a blocking
 *    rule gives needs_review;
 *  - recommend_reject only when every check was read, none is unusual, and a check failed on a rule the leave
 *    engine itself refuses on (the balance below the type's floor, or an overlap with the applicant's own
 *    approved leave);
 *  - recommend_approve only when all four pass.
 * The approver always decides; nothing here records a decision. A model may only word the result; the wording
 * below is a deterministic template. Every computation writes one outcome record (worker
 * `approver_recommendation`), and the approver's later choice can be appended as agreement or disagreement.
 * Runs only while the worker is switched on and the tenant is not stopped. Not imported by the production
 * Assistant. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {leaveType as leaveTypeTable} from '../../db/schema';
import {terasOutcomeRecord} from '../../db/teras-schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {pendingLeaveTaskMetadata} from '../../packs/leave/service';
import {workerRunGateTx} from '../agent-registry/controls';
import {newRunId,recordOutcomeFollowup,writeOutcomeRecordTx,type OutcomeCheck} from '../outcome-record/record';
import {leavePolicyVersionTx} from '../outcome-record/rule-versions';
import {listLeaveRequests,plannedAbsences} from '../read';
import {RECOMMENDATION_CHECKS,type RECOMMENDATION_RESULTS,type RECOMMENDATION_VERDICTS} from '../semantic-model/entities-recommend';

export const RECOMMENDER_VERSION='leave_decision_recommender:v1';
export const RECOMMENDER_WORKER='approver_recommendation';
export const RECOMMENDER_AGENT_IDENTITY='worker.approver_recommendation';
export type RecommendationVerdict=(typeof RECOMMENDATION_VERDICTS)[number];
export type RecommendationCheckName=(typeof RECOMMENDATION_CHECKS)[number];
export type RecommendationResult=(typeof RECOMMENDATION_RESULTS)[number];
export type RecommendationCheck=Readonly<{check:RecommendationCheckName;owner:string;ruleVersion:string|null;result:RecommendationResult;
 /** A failure the leave engine itself refuses on; only a blocking failure can recommend rejection. */blocking:boolean}>;
export type LeaveDecisionRecommendation=Readonly<{kind:'teras.recommendation';version:1;action:'approvals.leave.decide';
 verdict:RecommendationVerdict;checks:readonly RecommendationCheck[];recommenderVersion:string;recordId:string|null}>;

/** The verdict from the checks alone. Any check absent from the list counts as missing. */
export function evaluateLeaveDecision(checks:readonly RecommendationCheck[]):RecommendationVerdict{
 const byName=RECOMMENDATION_CHECKS.map(name=>checks.filter(check=>check.check===name));
 if(byName.some(rows=>rows.length!==1))return'needs_review';
 const rows=byName.map(found=>found[0]);
 if(rows.some(row=>row.result==='missing'||row.result==='unusual'))return'needs_review';
 if(rows.some(row=>row.result==='fail'&&!row.blocking))return'needs_review';
 if(rows.some(row=>row.result==='fail'))return'recommend_reject';
 return rows.every(row=>row.result==='pass')?'recommend_approve':'needs_review';
}

/** What the native reads returned, or null where a read could not be made. */
export type LeaveDecisionFacts=Readonly<{
 request:Readonly<{startDate:string;endDate:string;days:number;hasDocument:boolean}>;
 balanceNow:number|null;
 ownLeave:Readonly<{complete:boolean;overlappingApproved:number;overlappingPending:number}>|null;
 othersAway:number|null;
 leaveType:Readonly<{allowNegativeBalance:boolean;maxNegativeBalance:number|null;requiresDocument:boolean;mandatoryAfterDays:number|null}>|null;
 policyVersion:string|null;today:string}>;

const OWNERS={balance:'core/read.ts#listLeaveRequests',overlap:'core/read.ts#listLeaveRequests',coverage:'core/read.ts#plannedAbsences',policy:'core/outcome-record/rule-versions.ts#leavePolicyVersionTx'} as const;
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
  const [approved,pending]=await Promise.all([listLeaveRequests(ctx,undefined,READ_CAP,{status:'approved'}),listLeaveRequests(ctx,undefined,READ_CAP,{status:'pending'})]);
  const own=(rows:typeof approved)=>rows.filter(other=>other.employmentId===request.employmentId&&other.id!==request.id&&overlaps(other,request));
  const ownApproved=own(approved),ownPending=own(pending);
  ownLeave={complete:approved.length<READ_CAP&&pending.length<READ_CAP,overlappingApproved:ownApproved.length,overlappingPending:ownPending.length};
  reads.push({tool:'core/read.ts#listLeaveRequests',status:'ok',refs:[...ownApproved,...ownPending].map(other=>other.id)});
 }catch{reads.push({tool:'core/read.ts#listLeaveRequests',status:'failed'});}
 let othersAway:number|null=null;
 try{
  const people=await plannedAbsences(ctx,undefined,{from:request.startDate,to:request.endDate});
  othersAway=people.filter(person=>person.id!==request.personId&&person.leaves.length>0).length;
  reads.push({tool:'core/read.ts#plannedAbsences',status:'ok'});
 }catch{reads.push({tool:'core/read.ts#plannedAbsences',status:'failed'});}
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
 const verdict=evaluateLeaveDecision(checks);
 // The record is written only while the worker may still run: a switch-off or stop in between ends it unrecorded.
 const recordId=await withTenant(ctx,async tx=>{
  if(!(await workerRunGateTx(tx,ctx,RECOMMENDER_WORKER)).run)return null;
  const record=await writeOutcomeRecordTx(tx,ctx,{runId:newRunId(),runKind:'turn',startedAt,finishedAt:new Date(Math.max(Date.now(),startedAt.getTime())),
   authority:{kind:'person',askedByUserId:ctx.userId!},agentIdentity:RECOMMENDER_AGENT_IDENTITY,reads,
   checks:checks.map((check):OutcomeCheck=>({check:check.check,owner:check.owner,ruleVersion:check.ruleVersion,
    result:check.result==='pass'?'pass':check.result==='fail'?'fail':'needs_review'})),
   replay:{model:null,provider:null,instructionSet:RECOMMENDER_VERSION,specVersion:null,specDigest:null,toolCatalogue:null},
   outcomeKind:'suggested',outcome:{action:'approvals.leave.decide',verdict,leaveRequestId:request.id,checks:checks.map(check=>`${check.check}:${check.result}`)},
   humanInvolvement:'none',notice:'not_given'});
  return record.id;
 });
 if(recordId===null)return unavailable('stopped');
 return Object.freeze({kind:'recommendation' as const,recommendation:Object.freeze({kind:'teras.recommendation' as const,version:1 as const,
  action:'approvals.leave.decide' as const,verdict,checks,recommenderVersion:RECOMMENDER_VERSION,recordId})});
}

const VERDICT_TEXT:Readonly<Record<RecommendationVerdict,string>>={recommend_approve:'Recommend approve: every check passed.',
 needs_review:'Needs your review: at least one check could not be confirmed.',recommend_reject:'Recommend reject: a leave rule would refuse this request.'};
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
 return [VERDICT_TEXT[recommendation.verdict],...recommendation.checks.map(check=>CHECK_TEXT[check.check][check.result])].join(' ');
}

/** After the approver decided on the review route: whether they followed the recommendation. Appended to the
 * recommendation's own outcome record (agreement metrics). needs_review recommends nothing, so it records
 * nothing. The verdict is read from the record, never taken from the caller. */
export async function recordRecommendationDecision(supplied:SessionContext,input:Readonly<{recordId:string;decision:'approved'|'rejected'}>):Promise<Readonly<{id:string}>|null>{
 const ctx=capture(supplied);
 if(input.decision!=='approved'&&input.decision!=='rejected')return null;
 const [record]=await withTenant(ctx,tx=>tx.select({outcome:terasOutcomeRecord.outcome,agentIdentity:terasOutcomeRecord.agentIdentity}).from(terasOutcomeRecord)
  .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasOutcomeRecord.id,input.recordId))).limit(1));
 if(!record||record.agentIdentity!==RECOMMENDER_AGENT_IDENTITY)return null;
 const verdict=record.outcome.verdict;
 if(verdict!=='recommend_approve'&&verdict!=='recommend_reject')return null;
 const followed=(verdict==='recommend_approve')===(input.decision==='approved');
 return recordOutcomeFollowup(ctx,{kind:'decision',recordId:input.recordId,decision:followed?'accepted':'rejected',humanInvolvement:'decided',
  reference:{decision:input.decision}});
}
