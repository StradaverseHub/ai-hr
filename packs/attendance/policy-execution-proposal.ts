/** Compose the canonical source projections through the one duration owner. This is arithmetic
 * preparation, not final-effect approval, a payable calculation or a cash/TOIL capability. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {AttendancePolicyDayClass} from '../../lib/attendance-group-policy';
import {attendancePolicyPlanInput,type PolicyPlanInput} from './policy-plan-input';
import type {PolicyApprovalInput} from './policy-approval-input';
import {intersectAttendancePolicyIntervals} from '../../lib/attendance-policy-intervals';
import type {PolicyWorkInput} from './policy-work-input';
import type {PolicyFormulaInput} from './policy-formula-input';
import {deriveAttendancePolicyDurationProposal,type PolicyDurationProposal} from './policy-duration';

export type PolicyExecutionProposal=
 |{state:'unavailable';authority:'proposalOnly';reason:'contextUnavailable'|'activationUnavailable'|'workUnavailable'|'approvalReceiptRequired'|'plannedProofRequired'|'formulaUnavailable'|'formulaBindingMismatch'}
 |{state:'proposed';authority:'proposalOnly';policyRevisionId:string;duration:PolicyDurationProposal;
   /** Exact existing formula identities; no assignment is synthesized for these derived parts. */
   formulaParts:{date:string;dayClass:AttendancePolicyDayClass;versionId:string;definitionDigest:string}[];
   /** The complete dated approval set stays bound even if redundant windows normalize away. */
   planEvidence?:Extract<PolicyPlanInput,{state:'known'}>};

export function attendancePolicyExecutionProposal(context:AttendancePolicyExecutionContext|undefined,
 work:PolicyWorkInput|undefined,formulas:PolicyFormulaInput|undefined,
 approvals?:PolicyApprovalInput,tenantId?:string):PolicyExecutionProposal{
 const unavailable=(reason:Extract<PolicyExecutionProposal,{state:'unavailable'}>['reason']):PolicyExecutionProposal=>({state:'unavailable',authority:'proposalOnly',reason});
 if(context?.state!=='policy')return unavailable('contextUnavailable');
 const {selected}=context;
 if(!Number.isSafeInteger(selected.activation.epoch)||selected.activation.epoch<1)return unavailable('activationUnavailable');
 if(work?.state!=='known')return unavailable('workUnavailable');
 // Manual still needs its frozen method and complete current-effect consumption. Auto planned
 // methods additionally require the newly owner-issued dated plan set, never scalar/audit labels.
 if(selected.policy.overtime.enabled&&selected.policy.overtime.approval!=='auto')return unavailable('approvalReceiptRequired');
 let planned:ReturnType<typeof attendancePolicyPlanInput>|undefined;
 const method=selected.policy.overtime.enabled?selected.policy.overtime.autoMethod:'actual';
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
  const previous=allocationByClass[reference.dayClass];
  if(previous!==undefined&&previous!==reference.definition.durationAllocation)return unavailable('formulaBindingMismatch');
  allocationByClass[reference.dayClass]=reference.definition.durationAllocation;
 }
 const duration=deriveAttendancePolicyDurationProposal({sourceDate:context.date,companyId:context.companyId,periodMinutes:work.periodMinutes,
  policy:selected.policy,workedIntervals:work.workedIntervals,eligibleActualIntervals:work.eligibleActualIntervals,
  eligiblePlannedIntervals:plannedIntervals,unpaidIntervals:work.unpaidIntervals,lateOffsetIntervals:work.lateOffsetIntervals,
  calendar:context.calendar,method,approval:'policyAuto',allocationByClass});
 const formulaParts:Extract<PolicyExecutionProposal,{state:'proposed'}>['formulaParts']=[];
 if(duration.status==='calculated')for(const part of duration.parts){
  const references=formulas?.state==='known'?formulas.references.filter(row=>row.date===part.date):[];
  const reference=references[0];
  if(references.length!==1||reference?.state!=='known')return unavailable('formulaUnavailable');
  if(reference.dayClass!==part.dayClass||reference.moneyDay!==part.moneyDay
   ||reference.versionId!==selected.policy.overtime.days[part.dayClass].patternVersionId)return unavailable('formulaBindingMismatch');
  formulaParts.push({date:part.date,dayClass:part.dayClass,versionId:reference.versionId,definitionDigest:reference.definitionDigest});
 }
 return {state:'proposed',authority:'proposalOnly',policyRevisionId:selected.id,duration,formulaParts,...(planned?.state==='known'?{planEvidence:planned}:{})};
}
