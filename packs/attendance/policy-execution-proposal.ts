import {attendancePolicyManualDurationInput,type PolicyRawEffectSource,type PolicyManualDurationInput} from './policy-manual-duration';
/** Compose the canonical source projections through the one duration owner. This is arithmetic
 * preparation, not final-effect approval, a payable calculation or a cash/TOIL capability. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {AttendancePolicyDayClass} from '../../lib/attendance-group-policy';
import {attendancePolicyPlanInput,type PolicyPlanInput} from './policy-plan-input';
import type {PolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyIntervalMinutes,intersectAttendancePolicyIntervals} from '../../lib/attendance-policy-intervals';
import type {PolicyWorkInput} from './policy-work-input';
import type {PolicyFormulaInput,PolicyDurationFormulaInput} from './policy-formula-input';
import {deriveAttendancePolicyDurationProposal,selectAttendancePolicyCandidate,type PolicyDurationProposal} from './policy-duration';

export type PolicyExecutionProposal=
 |{state:'unavailable';authority:'proposalOnly';reason:'contextUnavailable'|'activationUnavailable'|'workUnavailable'|'approvalReceiptRequired'|'plannedProofRequired'|'formulaUnavailable'|'formulaBindingMismatch'}
 |{state:'proposed';authority:'proposalOnly';policyRevisionId:string;duration:PolicyDurationProposal;
   /** Exact existing formula identities; no assignment is synthesized for these derived parts. */
   formulaParts:{date:string;dayClass:AttendancePolicyDayClass;versionId:string;definitionDigest:string}[];
   /** The complete dated approval set stays bound even if redundant windows normalize away. */
   planEvidence?:Extract<PolicyPlanInput,{state:'known'}>;manualEvidence?:Extract<PolicyManualDurationInput,{state:'known'}>};

/** Actual captured eligibility for the existing four scalar approval methods, before the
 * once-only group duration finalization. This is not an approved/payable duration or method choice. */
export function attendancePolicySystemEligibleMinutes(context:AttendancePolicyExecutionContext|undefined,work:PolicyWorkInput|undefined){
 const refuse=(reason:'contextUnavailable'|'workUnavailable'|'lateEvidenceUnavailable')=>
  ({state:'unavailable' as const,authority:'policyActualComparisonOnly' as const,reason});
 if(context?.state!=='policy')return refuse('contextUnavailable');
 if(work?.state!=='known')return refuse('workUnavailable');
 if(!context.selected.policy.overtime.enabled)return {state:'known' as const,authority:'policyActualComparisonOnly' as const,minutes:0};
 const selection=selectAttendancePolicyCandidate({eligibleIntervals:work.eligibleActualIntervals,unpaidIntervals:work.unpaidIntervals,
  lateOffsetIntervals:work.lateOffsetIntervals,offsetLateness:context.selected.policy.overtime.offsetLateness,periodMinutes:work.periodMinutes});
 if(selection.state!=='known')return refuse(selection.reason);
 return {state:'known' as const,authority:'policyActualComparisonOnly' as const,
  minutes:attendancePolicyIntervalMinutes(selection.afterOffset.intervals,work.periodMinutes)};
}

export function attendancePolicyExecutionProposal(context:AttendancePolicyExecutionContext|undefined,
 work:PolicyWorkInput|undefined,formulas:PolicyFormulaInput|undefined,
 approvals?:PolicyApprovalInput,tenantId?:string,rawEffect?:PolicyRawEffectSource):PolicyExecutionProposal{
 return composeAttendancePolicyDuration(context,work,formulas,approvals,tenantId,rawEffect);
}
/** TOIL's duration proposal shares the same arithmetic and approval requirements. A duration-only
 * source is not a cash formula/mapping input and cannot be submitted to the money reader API. */
export function attendancePolicyDurationExecutionProposal(context:AttendancePolicyExecutionContext|undefined,
 work:PolicyWorkInput|undefined,formulas:PolicyDurationFormulaInput|undefined,
 approvals?:PolicyApprovalInput,tenantId?:string,rawEffect?:PolicyRawEffectSource):PolicyExecutionProposal{
 return composeAttendancePolicyDuration(context,work,formulas,approvals,tenantId,rawEffect);
}
function composeAttendancePolicyDuration(context:AttendancePolicyExecutionContext|undefined,
 work:PolicyWorkInput|undefined,formulas:PolicyFormulaInput|PolicyDurationFormulaInput|undefined,
 approvals?:PolicyApprovalInput,tenantId?:string,rawEffect?:PolicyRawEffectSource):PolicyExecutionProposal{
 const unavailable=(reason:Extract<PolicyExecutionProposal,{state:'unavailable'}>['reason']):PolicyExecutionProposal=>({state:'unavailable',authority:'proposalOnly',reason});
 if(context?.state!=='policy')return unavailable('contextUnavailable');
 const {selected}=context;
 if(!Number.isSafeInteger(selected.activation.epoch)||selected.activation.epoch<1)return unavailable('activationUnavailable');
 if(work?.state!=='known')return unavailable('workUnavailable');
 // Manual still needs its frozen method and complete current-effect consumption. Auto planned
 // methods additionally require the newly owner-issued dated plan set, never scalar/audit labels.
 const manual=selected.policy.overtime.enabled&&selected.policy.overtime.approval==='manual'
  ?attendancePolicyManualDurationInput(context,work,approvals,tenantId??'',rawEffect):undefined;
 if(manual?.state==='unavailable')return unavailable('approvalReceiptRequired');
 let planned:ReturnType<typeof attendancePolicyPlanInput>|undefined;
 const method=selected.policy.overtime.enabled&&!manual?selected.policy.overtime.autoMethod:'actual';
 if(selected.policy.overtime.enabled&&method!=='actual'){
  planned=attendancePolicyPlanInput(context,approvals,tenantId??'');
  if(planned.state!=='known'||context.placement.state!=='known')return unavailable('plannedProofRequired');
 }
 // The same schedule owner gates actual and plan eligibility. The plan union itself is neither
 // worked coverage nor an OT window; breaks and measured late offset remain the duration owner's.
 const plannedIntervals=planned?.state==='known'&&context.placement.state==='known'
  ?intersectAttendancePolicyIntervals(planned.intervals,context.placement.eligibilityWindows,work.periodMinutes):null;
 const allocationByClass:Partial<Record<AttendancePolicyDayClass,'earliest'|'latest'>>={};
 if(selected.policy.overtime.enabled&&formulas?.state!=='known')return unavailable('formulaUnavailable');
 if(formulas?.state==='known')for(const reference of formulas.references){
  if(reference.state!=='known')continue;
  if(selected.policy.overtime.days[reference.dayClass].patternVersionId!==reference.versionId)return unavailable('formulaBindingMismatch');
  const direction='definition' in reference?reference.definition.durationAllocation:reference.durationAllocation;
  const previous=allocationByClass[reference.dayClass];
  if(previous!==undefined&&previous!==direction)return unavailable('formulaBindingMismatch');
  allocationByClass[reference.dayClass]=direction;
 }
 const duration=deriveAttendancePolicyDurationProposal({sourceDate:context.date,companyId:context.companyId,periodMinutes:work.periodMinutes,
  policy:selected.policy,workedIntervals:work.workedIntervals,eligibleActualIntervals:work.eligibleActualIntervals,
  eligiblePlannedIntervals:plannedIntervals,unpaidIntervals:work.unpaidIntervals,lateOffsetIntervals:work.lateOffsetIntervals,
  calendar:context.calendar,method,approval:manual?.state==='known'?'approved':'policyAuto',allocationByClass,
  ...(manual?.state==='known'?{manualApprovedIntervals:manual.intervals}:{})});
 const formulaParts:Extract<PolicyExecutionProposal,{state:'proposed'}>['formulaParts']=[];
 if(duration.status==='calculated')for(const part of duration.parts){
  const references=formulas?.state==='known'?formulas.references.filter(row=>row.date===part.date):[];
  const reference=references[0];
  if(references.length!==1||reference?.state!=='known')return unavailable('formulaUnavailable');
  if(reference.dayClass!==part.dayClass||reference.moneyDay!==part.moneyDay
   ||reference.versionId!==selected.policy.overtime.days[part.dayClass].patternVersionId)return unavailable('formulaBindingMismatch');
  formulaParts.push({date:part.date,dayClass:part.dayClass,versionId:reference.versionId,definitionDigest:reference.definitionDigest});
 }
 return {state:'proposed',authority:'proposalOnly',policyRevisionId:selected.id,duration,formulaParts,...(planned?.state==='known'?{planEvidence:planned}:{}),...(manual?.state==='known'?{manualEvidence:manual}:{})};
}

/** Old immutable refused rounding proposals predate source/count attribution. Compare their
 * original shape without inventing an attribution or promoting them to a known/ready result.
 * Every other proposal field remains subject to the caller's exact canonical comparison. */
export function attendancePolicyRecordedProposalComparison(current:PolicyExecutionProposal,recorded:PolicyExecutionProposal|undefined):PolicyExecutionProposal{
 if(current.state!=='proposed'||current.duration.status!=='calculated'||recorded?.state!=='proposed'
  ||recorded.duration.status!=='calculated'||!Array.isArray(recorded.duration.classes)
  ||!recorded.duration.classes.some(row=>row.unplacedPayableMinutes>0)
  ||recorded.duration.classes.some(row=>Object.hasOwn(row,'roundingCountAttribution')))return current;
 return {...current,duration:{...current.duration,classes:current.duration.classes.map(row=>{
  const {roundingCountAttribution:ignored,...original}=row;void ignored;return original;
 })}};
}
