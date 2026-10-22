/** Compose the canonical source projections through the one duration owner. This is arithmetic
 * preparation, not final-effect approval, a payable calculation or a cash/TOIL capability. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {AttendancePolicyDayClass} from '../../lib/attendance-group-policy';
import type {PolicyWorkInput} from './policy-work-input';
import type {PolicyFormulaInput} from './policy-formula-input';
import {deriveAttendancePolicyDurationProposal,type PolicyDurationProposal} from './policy-duration';

export type PolicyExecutionProposal=
 |{state:'unavailable';authority:'proposalOnly';reason:'contextUnavailable'|'activationUnavailable'|'workUnavailable'|'approvalReceiptRequired'|'plannedProofRequired'|'formulaUnavailable'|'formulaBindingMismatch'}
 |{state:'proposed';authority:'proposalOnly';policyRevisionId:string;duration:PolicyDurationProposal;
   /** Exact existing formula identities; no assignment is synthesized for these derived parts. */
   formulaParts:{date:string;dayClass:AttendancePolicyDayClass;versionId:string;definitionDigest:string}[]};

export function attendancePolicyExecutionProposal(context:AttendancePolicyExecutionContext|undefined,
 work:PolicyWorkInput|undefined,formulas:PolicyFormulaInput|undefined):PolicyExecutionProposal{
 const unavailable=(reason:Extract<PolicyExecutionProposal,{state:'unavailable'}>['reason']):PolicyExecutionProposal=>({state:'unavailable',authority:'proposalOnly',reason});
 if(context?.state!=='policy')return unavailable('contextUnavailable');
 const {selected}=context;
 if(!Number.isSafeInteger(selected.activation.epoch)||selected.activation.epoch<1)return unavailable('activationUnavailable');
 if(work?.state!=='known')return unavailable('workUnavailable');
 // The existing request projection is audit evidence, not a new approval receipt. In particular a
 // scalar approved amount or display HH:mm labels cannot authorize Manual/Pre-Approved/Intersect.
 if(selected.policy.overtime.enabled&&selected.policy.overtime.approval!=='auto')return unavailable('approvalReceiptRequired');
 if(selected.policy.overtime.enabled&&selected.policy.overtime.autoMethod!=='actual')return unavailable('plannedProofRequired');
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
  eligiblePlannedIntervals:null,unpaidIntervals:work.unpaidIntervals,lateOffsetIntervals:work.lateOffsetIntervals,
  calendar:context.calendar,method:'actual',approval:'policyAuto',allocationByClass});
 const formulaParts:Extract<PolicyExecutionProposal,{state:'proposed'}>['formulaParts']=[];
 if(duration.status==='calculated')for(const part of duration.parts){
  const references=formulas?.state==='known'?formulas.references.filter(row=>row.date===part.date):[];
  const reference=references[0];
  if(references.length!==1||reference?.state!=='known')return unavailable('formulaUnavailable');
  if(reference.dayClass!==part.dayClass||reference.moneyDay!==part.moneyDay
   ||reference.versionId!==selected.policy.overtime.days[part.dayClass].patternVersionId)return unavailable('formulaBindingMismatch');
  formulaParts.push({date:part.date,dayClass:part.dayClass,versionId:reference.versionId,definitionDigest:reference.definitionDigest});
 }
 return {state:'proposed',authority:'proposalOnly',policyRevisionId:selected.id,duration,formulaParts};
}
