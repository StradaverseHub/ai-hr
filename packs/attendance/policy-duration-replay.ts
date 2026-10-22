/** Price-independent replay of one canonical duration proposal. This is neither a ready
 * calculation nor approval/settlement authority; financial consumers must retain their guards. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyDurationFormulaProjection} from './policy-formula-source';
import {attendancePolicyDurationExecutionProposal} from './policy-execution-proposal';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';
import {attendancePolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';
import {attendancePolicyWorkInput} from './policy-work-input';
import {attendancePolicyClockMeasurements} from './policy-clock-measurements';

export type PolicyDurationReplay=
 |{state:'unavailable';authority:'durationProposalReplayOnly';reason:'sourceUnavailable'|'proposalMismatch'|'countPlacementUnavailable'}
 |{state:'known';authority:'durationProposalReplayOnly';digest:string;minutes:number};
/** Money definitions, salary facts, earning references and the cash input/reference digests are
 * deliberately absent. Frozen formula identities/directions, complete approval references and
 * actual capture identities remain bound, even when changing one leaves the minute total equal. */
export function attendancePolicyDurationReplay(snapshot:CanonicalOvertimeSnapshot):PolicyDurationReplay{
 const refuse=(reason:Extract<PolicyDurationReplay,{state:'unavailable'}>['reason']):PolicyDurationReplay=>
  ({state:'unavailable',authority:'durationProposalReplayOnly',reason});
 try{
  const source=snapshot.input.source,policy=snapshot.attendanceGroupPolicy,context=snapshot.policyExecutionContext;
  overtimeUuid(source.tenantId,'tenantId');overtimeUuid(source.employmentId,'employmentId');
  overtimeUuid(source.attendanceId,'attendanceId');overtimeDate(source.date,'date');
  if(!policy||context?.state!=='policy'||context.employmentId!==source.employmentId||context.date!==source.date
   ||context.companyId!==policy.companyId||!isDeepStrictEqual(context.selected,policy)
   ||snapshot.policyClockSource?.state!=='known'||snapshot.policyClockReview?.state!=='known'
   ||!snapshot.policyClockReview.evidence.complete||snapshot.policyClockReview.evidence.requiresReview
   ||snapshot.policyWorkInput?.state!=='known'||!snapshot.policyApprovalInput)return refuse('sourceUnavailable');
  const captured=attendancePolicyClockMillisecondEvidence(snapshot.policyClockSource.clocks,context.resolvedClock,4320);
  if(!isDeepStrictEqual(captured,snapshot.policyClockReview.evidence)
   ||!isDeepStrictEqual(attendancePolicyWorkInput(context,captured),snapshot.policyWorkInput)
   ||!isDeepStrictEqual(attendancePolicyClockMeasurements(context,captured),snapshot.policyClockMeasurements))return refuse('proposalMismatch');
  // An explicit duration refusal is authoritative; never bypass it through the money source.
  const formulas=snapshot.policyDurationFormulaInput!==undefined?snapshot.policyDurationFormulaInput
   :snapshot.policyFormulaInput?attendancePolicyDurationFormulaProjection(snapshot.policyFormulaInput):undefined;
  if(formulas?.state!=='known')return refuse('sourceUnavailable');
  const proposal=attendancePolicyDurationExecutionProposal(context,snapshot.policyWorkInput,formulas,snapshot.policyApprovalInput,source.tenantId);
  if(!isDeepStrictEqual(proposal,snapshot.policyExecutionProposal))return refuse('proposalMismatch');
  if(proposal.state!=='proposed'||proposal.duration.status!=='calculated')return refuse('sourceUnavailable');
  const duration=proposal.duration;
  if(duration.classes.some(row=>row.unplacedPayableMinutes!==0)
   ||duration.parts.reduce((sum,row)=>sum+row.allocatedPayableMinutes,0)!==duration.payableMinutes)
   return refuse('countPlacementUnavailable');
  const proof={version:1,source:{tenantId:source.tenantId,employmentId:source.employmentId,attendanceId:source.attendanceId,date:source.date},
   policy,context,clocks:snapshot.policyClockSource,clockReview:snapshot.policyClockReview,
   measurements:snapshot.policyClockMeasurements,work:snapshot.policyWorkInput,approvals:snapshot.policyApprovalInput,formulas,proposal};
  return {state:'known',authority:'durationProposalReplayOnly',digest:createHash('sha256').update(JSON.stringify(proof)).digest('hex'),minutes:duration.payableMinutes};
 }catch{return refuse('sourceUnavailable');}
}
/** A historical digest alone proves nothing current. Caller must obtain the snapshot through
 * canonical fresh reads under the source/epoch locks before comparing this complete projection. */
export function attendancePolicyCurrentDurationMatches(snapshot:CanonicalOvertimeSnapshot,recorded:unknown):boolean{
 const current=attendancePolicyDurationReplay(snapshot);
 return current.state==='known'&&isDeepStrictEqual(current,recorded);
}
