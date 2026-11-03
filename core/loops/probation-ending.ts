/** AI v2 W8 loop 1 — probation ending.
 *
 * Detect: a probation that ends within PROBATION_HORIZON_DAYS with no decision recorded for that end date, from the
 * employment-review owner (core/employment-review.ts probationDecisionFacts: the live end date resolved by
 * computeReviewWindow and the latest probation review). A person with a pending resignation is not opened.
 * Diagnose: whether a review exists and at which stage (none, with the manager, with HR).
 * Prepare: a confirmation review card for HR administrators of the employment. The loop never decides: the card opens
 * the review where HR records confirm, extend or terminate, or the employee's record when no review is open yet.
 * Verify: done when a decision is recorded for the current end date; superseded when the end date moved beyond the
 * window or no probation applies any more; inactive when the employment ended. An overdue undecided probation stays
 * open. A later end date coming into the window with no decision for it reopens the case. */
import type {SessionContext} from '../../db/client';
import {probationDecisionFacts} from '../employment-review';
import {addHrDays} from '../../lib/today/audience';
import {read,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';

export const PROBATION_HORIZON_DAYS=14;
export const PROBATION_LOOP_VERSION='loop_probation_ending@v1';
const OWNER='core/employment-review.ts#probationDecisionFacts';
export const probationKey=(employmentId:string)=>`probation:${employmentId}`;

export async function detectProbationEnding(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const horizon=addHrDays(input.today,PROBATION_HORIZON_DAYS);
 const tracked=new Map(input.tracked.map(item=>[item.subjectKey,item]));
 const facts=await probationDecisionFacts(sponsor,{companyIds:input.companyIds,employmentIds:input.tracked.flatMap(item=>item.employmentId?[item.employmentId]:[])});
 const scope=new Set(input.companyIds),observations:LoopObservation[]=[];
 for(const fact of facts){
  const key=probationKey(fact.employmentId),known=tracked.get(key);
  // A tracked case is verified wherever the employment now is; a new one is opened only in a company in scope.
  if(!known&&!scope.has(fact.companyId))continue;
  const companyId=known?.companyId??fact.companyId;
  const base={subjectKey:key,companyId,employmentId:fact.employmentId,recipient:'hr' as const};
  if(fact.terminated){if(known)observations.push({...base,state:'closed',closeReason:'inactive',facts:known.facts});continue;}
  const end=fact.endDate,review=fact.review;
  const decided=!!end&&!!review&&review.decision!==null&&review.endDate===end;
  if(decided){observations.push({...base,state:'closed',closeReason:'done',resolution:'completed',facts:{endDate:end,decision:review!.decision}});continue;}
  if(!end||end>horizon){
   if(known)observations.push({...base,state:'closed',closeReason:'superseded',facts:end?{endDate:end}:{}});
   continue;
  }
  // Undecided and ending inside the window (or already past it, for a case already open).
  if(end<input.today&&!known)continue;
  if(fact.resigning&&!known)continue;
  const stage=!review||review.endDate!==end||review.status==='cancelled'?'none':review.status==='pending_hr'?'with_hr':review.status==='pending_manager'?'with_manager':'none';
  observations.push({...base,state:'open',facts:{endDate:end,stage,overdue:end<input.today,
   ...(stage!=='none'&&review?{reviewId:review.id,managerSubmitted:review.managerSubmitted}:{})}});
 }
 return {observations,reads:[read('employment_review.probation_decision_facts',OWNER)]};
}
