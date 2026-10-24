import {attendancePolicySourceReservationCoverage} from './policy-source-reservation-coverage';
import {attendancePolicyApprovedPlanQuantity} from './policy-approved-plan-quantity';
import {attendancePolicyCapturedCoverageProposal} from './policy-captured-coverage';
import {attendancePolicyCashReplay} from './policy-cash-replay';
import {attendancePolicyPricingProposal} from './policy-pricing-proposal';
import {attendancePolicyCountAttribution} from './policy-count-attribution';
/** Complete immutable proposal parts beneath ONE calculation. This does not grant approval,
 * generate payment lines or settle cash/TOIL. Parent identities/digests are bound by the writer. */
import {isDeepStrictEqual} from 'node:util';
import type {attendanceOvertimePolicyPart,attendanceOvertimeCalculation,attendanceOvertimeSource} from '../../db/schema';
import type {ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {PolicyApprovalInput} from './policy-approval-input';
import type {PolicyWorkInput} from './policy-work-input';
import type {PolicyFormulaInput,PolicyDurationFormulaInput} from './policy-formula-source';
import {attendancePolicyExecutionProposal,attendancePolicyDurationExecutionProposal,attendancePolicyRecordedProposalComparison,type PolicyExecutionProposal} from './policy-execution-proposal';
import {attendancePolicyDurationReplay,attendancePolicyRecordedApprovalStatus} from './policy-duration-replay';
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';

export type PolicyProposalStoragePart=Pick<typeof attendanceOvertimePolicyPart.$inferInsert,
 'sequence'|'calendarDate'|'dayClass'|'moneyDay'|'versionId'|'rawMinutes'|'allocatedPayableMinutes'|'sourceIntervals'|'calendarReferences'|'durationEvidence'>;
export type PolicyProposalPartSource={source:{employmentId:string;date:string;tenantId?:string};policy?:ResolvedAttendanceGroupPolicy;
 context?:AttendancePolicyExecutionContext;work?:PolicyWorkInput;formulas?:PolicyFormulaInput;durationFormulas?:PolicyDurationFormulaInput;approvals?:PolicyApprovalInput;proposal?:PolicyExecutionProposal;planQuantityScope?:CanonicalOvertimeSnapshot['policyPlanQuantityScope'];rawEffect?:CanonicalOvertimeSnapshot['policyRawEffectSource']};

/** Null rejects inconsistent prepared evidence. Empty means no complete proposal to materialize.
 * Rounding remainder stays on the parent's class evidence, never an invented child clock/date. */
export function materializeAttendancePolicyProposalParts(input:PolicyProposalPartSource):PolicyProposalStoragePart[]|null{
 if(!input.policy)return input.proposal?null:[];
 if(!input.proposal)return [];
 const context=input.context;
 if(context?.state==='policy'&&(context.employmentId!==input.source.employmentId||context.date!==input.source.date
  ||context.companyId!==input.policy.companyId||!isDeepStrictEqual(context.selected,input.policy)))return null;
 const computed=input.durationFormulas!==undefined
  ?attendancePolicyDurationExecutionProposal(context,input.work,input.durationFormulas,input.approvals,input.source.tenantId,input.rawEffect)
  :attendancePolicyExecutionProposal(context,input.work,input.formulas,input.approvals,input.source.tenantId,input.rawEffect);
 const expected=attendancePolicyRecordedProposalComparison(computed,input.proposal);
 if(!isDeepStrictEqual(expected,input.proposal))return null;
 if(expected.state!=='proposed'||expected.duration.status!=='calculated')return [];
 if(expected.policyRevisionId!==input.policy.id||expected.duration.parts.length>3
  ||expected.formulaParts.length!==expected.duration.parts.length)return null;
 const duration=expected.duration,count=attendancePolicyCountAttribution(duration);
 // Legacy absent-attribution proposals retain only their original refused physical parts.
 if(count.state!=='known'&&(!duration.classes.some(row=>row.unplacedPayableMinutes>0)
  ||duration.classes.some(row=>Object.hasOwn(row,'roundingCountAttribution'))))return null;
 const parts:PolicyProposalStoragePart[]=[];
 for(const [sequence,part]of duration.parts.entries()){
  const formula=expected.formulaParts[sequence];
  if(formula.date!==part.date||formula.dayClass!==part.dayClass||part.companyId!==input.policy.companyId)return null;
  if(input.planQuantityScope!==undefined){
   if(input.planQuantityScope!=='approvedPlanWithIndependentWorkedDay'||duration.intervalBasis!=='approvedPlan'||count.state!=='known')return null;
   parts.push({sequence,calendarDate:part.date,dayClass:part.dayClass,moneyDay:part.moneyDay,versionId:formula.versionId,
    // Planned quantities never occupy the columns/intervals describing physical work.
    rawMinutes:0,allocatedPayableMinutes:0,sourceIntervals:[],calendarReferences:[...part.calendarReferences],
    durationEvidence:{authority:'proposalOnly',policyRevisionId:input.policy.id,intervalBasis:'approvedPlan',parentClass:part.dayClass,allocatedIntervals:[],
     planQuantity:{v:1,rawMinutes:part.minutes,selectedMinutes:part.allocatedPayableMinutes,payableMinutes:count.parts[sequence].minutes,
      sourceIntervals:part.intervals.map(row=>({...row})),allocatedIntervals:part.allocations.map(row=>({...row})),
      roundingCountAttributions:count.parts[sequence].roundingCountAttributions}}});continue;
  }
  parts.push({sequence,calendarDate:part.date,dayClass:part.dayClass,moneyDay:part.moneyDay,versionId:formula.versionId,
   rawMinutes:part.minutes,allocatedPayableMinutes:part.allocatedPayableMinutes,
   sourceIntervals:part.intervals.map(row=>({...row})),calendarReferences:[...part.calendarReferences],
   durationEvidence:{authority:'proposalOnly',policyRevisionId:input.policy.id,intervalBasis:expected.duration.intervalBasis,
    parentClass:part.dayClass,allocatedIntervals:part.allocations.map(row=>({...row})),
    // Separate count/date/source identity. Existing physical-count columns and intervals keep
    // their original meaning. Financial replay/SQL must explicitly adopt this count contract.
    ...(count.state==='known'&&count.parts[sequence].roundedMinutes>0?{roundingCountAttributions:count.parts[sequence].roundingCountAttributions,
     attributedPayableMinutes:count.parts[sequence].minutes}:{})}});
 }
 return parts;
}


type StoredPolicyParent=Pick<typeof attendanceOvertimeSource.$inferSelect,'id'|'tenantId'|'companyId'|'employmentId'|'attendanceDate'|'attendanceId'>;
type StoredPolicyCalculation=Pick<typeof attendanceOvertimeCalculation.$inferSelect,'id'|'sourceId'|'tenantId'|'companyId'|'bindingKind'|'policyRevisionId'|'policyPartCount'|'inputDigest'|'approvalDigest'|'referenceDigest'|'approvalStatus'>;
type StoredPolicyPart=Omit<typeof attendanceOvertimePolicyPart.$inferSelect,'createdAt'>;
/** Historical evidence replay only. This establishes neither current freshness nor financial authority.
 * Malformed JSON, any omitted part, and any changed business field refuse the entire parent. */
export function recordedAttendancePolicyProposalPartsMatch(source:StoredPolicyParent,header:StoredPolicyCalculation,
 evidence:unknown,rows:readonly StoredPolicyPart[]):boolean{
 try{
  if(header.bindingKind!=='attendanceGroupPolicy'||header.sourceId!==source.id||header.tenantId!==source.tenantId
   ||header.companyId!==source.companyId||!header.policyRevisionId||!Number.isSafeInteger(header.policyPartCount)
   ||header.policyPartCount<0||header.policyPartCount>3||rows.length!==header.policyPartCount)return false;
  if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))return false;
  const row=evidence as Record<string,unknown>;
  if(row.calculationId!==header.id||row.tenantId!==source.tenantId||row.companyId!==source.companyId
   ||!row.inputs||typeof row.inputs!=='object'||Array.isArray(row.inputs)
   ||!row.evidence||typeof row.evidence!=='object'||Array.isArray(row.evidence))return false;
  const inputs=row.inputs as Record<string,unknown>,inputSource=inputs.source as Record<string,unknown>|undefined;
  if(inputs.mode!=='actual'||inputs.assignmentId!==null||inputs.patternVersionId!==null||!inputSource
   ||inputSource.tenantId!==source.tenantId||inputSource.employmentId!==source.employmentId
   ||inputSource.attendanceId!==source.attendanceId||inputSource.date!==source.attendanceDate
   ||inputSource.inputDigest!==header.inputDigest||inputSource.approvalDigest!==header.approvalDigest)return false;
  const stored=row.evidence as Record<string,unknown>;
  const input:PolicyProposalPartSource={source:{employmentId:source.employmentId,date:source.attendanceDate,tenantId:source.tenantId},
   policy:stored.attendanceGroupPolicy as PolicyProposalPartSource['policy'],context:stored.policyExecutionContext as PolicyProposalPartSource['context'],
   work:stored.policyWorkInput as PolicyProposalPartSource['work'],formulas:stored.policyFormulaInput as PolicyProposalPartSource['formulas'],
   durationFormulas:stored.policyDurationFormulaInput as PolicyProposalPartSource['durationFormulas'],
   approvals:stored.policyApprovalInput as PolicyProposalPartSource['approvals'],
   proposal:stored.policyExecutionProposal as PolicyProposalPartSource['proposal'],planQuantityScope:stored.policyPlanQuantityScope as PolicyProposalPartSource['planQuantityScope'],rawEffect:stored.policyRawEffectSource as PolicyProposalPartSource['rawEffect']};
  if(!input.proposal||!input.policy||input.policy.id!==header.policyRevisionId||input.policy.companyId!==source.companyId)return false;
  const replaySnapshot:CanonicalOvertimeSnapshot={input:inputs as unknown as CanonicalOvertimeSnapshot['input'],resolvedLegacyRuleId:null,referenceDigest:header.referenceDigest,
   attendanceGroupPolicy:input.policy,policyExecutionContext:input.context,policyWorkInput:input.work,policyFormulaInput:input.formulas,
   policyApprovalInput:input.approvals,policyRawEffectSource:input.rawEffect,policyExecutionProposal:input.proposal,
   // Preserve an explicit duration-source refusal; absent legacy metadata keeps its original fallback.
   policyDurationFormulaInput:stored.policyDurationFormulaInput as CanonicalOvertimeSnapshot['policyDurationFormulaInput'],
   policyPricingFacts:stored.policyPricingFacts as CanonicalOvertimeSnapshot['policyPricingFacts'],
   policyPlanQuantityScope:input.planQuantityScope,
   policyMoneyScope:stored.policyMoneyScope as CanonicalOvertimeSnapshot['policyMoneyScope'],
   policyClockSource:stored.policyClockSource as CanonicalOvertimeSnapshot['policyClockSource'],
   policyClockReview:stored.policyClockReview as CanonicalOvertimeSnapshot['policyClockReview'],
   policyClockMeasurements:stored.policyClockMeasurements as CanonicalOvertimeSnapshot['policyClockMeasurements']};
  if(header.approvalStatus!==attendancePolicyRecordedApprovalStatus(replaySnapshot))return false;
  if(!isDeepStrictEqual(stored.policyCashReplay,attendancePolicyCashReplay(replaySnapshot))
   ||!isDeepStrictEqual(stored.policyDurationReplay,attendancePolicyDurationReplay(replaySnapshot))
   ||!isDeepStrictEqual(stored.policyPricingProposal,attendancePolicyPricingProposal(replaySnapshot)))return false;
  const coverage=attendancePolicySourceReservationCoverage({tenantId:source.tenantId,companyId:source.companyId,employmentId:source.employmentId,sourceId:source.id,calculationId:header.id,date:source.attendanceDate},replaySnapshot);
  if(!isDeepStrictEqual(stored.policyCoverage,coverage))return false;
  if(input.planQuantityScope&&!isDeepStrictEqual(stored.policyApprovedPlanQuantity,attendancePolicyApprovedPlanQuantity(replaySnapshot)))return false;
  if(!isDeepStrictEqual(stored.policyCapturedCoverage,attendancePolicyCapturedCoverageProposal(
   {tenantId:source.tenantId,companyId:source.companyId,employmentId:source.employmentId,sourceId:source.id,calculationId:header.id,date:source.attendanceDate},replaySnapshot)))return false;
  const expected=materializeAttendancePolicyProposalParts(input);
  if(expected===null||expected.length!==header.policyPartCount)return false;
  return rows.every((row,index)=>{
   if(row.calculationId!==header.id||row.tenantId!==source.tenantId||row.companyId!==source.companyId
    ||row.inputDigest!==header.inputDigest||row.sequence!==index)return false;
   const part:PolicyProposalStoragePart={sequence:row.sequence,calendarDate:row.calendarDate,dayClass:row.dayClass,
    moneyDay:row.moneyDay,versionId:row.versionId,rawMinutes:row.rawMinutes,allocatedPayableMinutes:row.allocatedPayableMinutes,
    sourceIntervals:row.sourceIntervals,calendarReferences:row.calendarReferences,durationEvidence:row.durationEvidence};
   return isDeepStrictEqual(part,expected[index]);
  });
 }catch{return false;}
}
