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
  const proposal=attendancePolicyDurationExecutionProposal(context,snapshot.policyWorkInput,formulas,snapshot.policyApprovalInput,source.tenantId,snapshot.policyRawEffectSource);
  if(!isDeepStrictEqual(proposal,snapshot.policyExecutionProposal))return refuse('proposalMismatch');
  if(proposal.state!=='proposed'||proposal.duration.status!=='calculated')return refuse('sourceUnavailable');
  const duration=proposal.duration;
  if(duration.classes.some(row=>row.unplacedPayableMinutes!==0)
   ||duration.parts.reduce((sum,row)=>sum+row.allocatedPayableMinutes,0)!==duration.payableMinutes)
   return refuse('countPlacementUnavailable');
  const proof={version:1,source:{tenantId:source.tenantId,employmentId:source.employmentId,attendanceId:source.attendanceId,date:source.date},
   policy,context,clocks:snapshot.policyClockSource,clockReview:snapshot.policyClockReview,
   ...(context.selected.policy.overtime.approval==='manual'?{rawEffect:snapshot.policyRawEffectSource}:{}),
   measurements:snapshot.policyClockMeasurements,work:snapshot.policyWorkInput,approvals:snapshot.policyApprovalInput,formulas,proposal};
  // PostgreSQL jsonb does not preserve object-key order. Retain array order (capture and
  // approval sequence), but canonicalize object keys before hashing writer/read-back evidence.
  const encoded=JSON.stringify(proof,(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)
   ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
  return {state:'known',authority:'durationProposalReplayOnly',digest:createHash('sha256').update(encoded).digest('hex'),minutes:duration.payableMinutes};
 }catch{return refuse('sourceUnavailable');}
}
/** A historical digest alone proves nothing current. Caller must obtain the snapshot through
 * canonical fresh reads under the source/epoch locks before comparing this complete projection. */
export function attendancePolicyCurrentDurationMatches(snapshot:CanonicalOvertimeSnapshot,recorded:unknown):boolean{
 const current=attendancePolicyDurationReplay(snapshot);
 return current.state==='known'&&isDeepStrictEqual(current,recorded);
}

/** Recorded policy approval requirement/status only. This does not establish a live final
 * effect, ready financial header or settlement authority. Legacy input approval facts remain
 * intact: their scalar selector cannot replace the new policy's actual approval contract. */
export function attendancePolicyRecordedApprovalStatus(snapshot:CanonicalOvertimeSnapshot):'approved'|'notRequired'|'pending'|'rejected'|'unknown'{
 try{
  const policy=snapshot.attendanceGroupPolicy,context=snapshot.policyExecutionContext;
  if(!policy||context?.state!=='policy'||!isDeepStrictEqual(context.selected,policy)
   ||context.employmentId!==snapshot.input.source.employmentId||context.date!==snapshot.input.source.date
   ||!Number.isSafeInteger(policy.activation.epoch)||policy.activation.epoch<1)return 'unknown';
  const overtime=policy.policy.overtime;
  if(!overtime.enabled||overtime.approval==='auto'&&overtime.autoMethod==='actual')return 'notRequired';
  const proposal=snapshot.policyExecutionProposal;
  if(attendancePolicyDurationReplay(snapshot).state==='known'&&proposal?.state==='proposed'
   &&(overtime.approval==='manual'?proposal.manualEvidence!==undefined:proposal.planEvidence!==undefined))return 'approved';
  const approvals=snapshot.policyApprovalInput;
  if(!approvals||approvals.policyRevisionId!==policy.id||approvals.mode!==overtime.approval
   ||approvals.autoMethod!==overtime.autoMethod||!isDeepStrictEqual(approvals.activation,policy.activation))return 'unknown';
  const active=approvals.requests.filter(row=>row.cancelledAt===null&&row.requestedMinutes!==null);
  if(active.some(row=>row.status==='pending'))return 'pending';
  if(active.length&&active.every(row=>row.status==='rejected'))return 'rejected';
  // An approved scalar row, missing final receipt, or incomplete captured proof is unknown.
  return 'unknown';
 }catch{return 'unknown';}
}
