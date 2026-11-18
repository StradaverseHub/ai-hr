import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyCapturedCoverageProposal} from './policy-captured-coverage';
import {attendancePolicyCoverageProposal,type PolicyCoverageIdentity,type PolicyCoverageProposal} from './policy-coverage';
/** A planned quantity reserves the independently proved complete worked-day footprint,
 * never the planned pricing coordinates. Old absent scope keeps its historical view. */
export function attendancePolicySourceReservationCoverage(identity:PolicyCoverageIdentity,snapshot:CanonicalOvertimeSnapshot):PolicyCoverageProposal{
 if(snapshot.policyPlanQuantityScope==='approvedPlanWithIndependentWorkedDay'){
  const covered=attendancePolicyCapturedCoverageProposal(identity,snapshot);
  return covered.state==='prepared'&&covered.countBasis==='approvedPlanWithIndependentWorkedDay'
   ?{state:'prepared',authority:'coverageProposalOnly',identity:{...identity},basis:'approvedPlan',intervals:covered.intervals.map(row=>({...row}))}
   :{state:'unavailable',authority:'coverageProposalOnly',reason:'partitionMismatch'};
 }
 return snapshot.policyExecutionProposal?attendancePolicyCoverageProposal(identity,snapshot.policyExecutionProposal)
  :{state:'unavailable',authority:'coverageProposalOnly',reason:'durationUnavailable'};
}
