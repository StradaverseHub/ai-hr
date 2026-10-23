/** Existing application facts are source evidence, never a new final-effect capability. */
import {isDeepStrictEqual} from 'node:util';
import {plannedOvertimeMinutes} from '../../lib/overtime-duration';
import type {attendanceCorrection,attendancePolicyRequestContract,attendancePolicyFinalReceipt} from '../../db/schema';
import type {ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';

export type PolicyApprovalSourceRow=Pick<typeof attendanceCorrection.$inferSelect,'id'|'tenantId'|'employmentId'|'attendanceDate'|'createdAt'|'status'|'requestedOtMinutes'|'approvedOtMinutes'|'otApprovalMethod'|'decidedByEmploymentId'|'decidedAt'|'appliedAt'|'cancelledAt'|'plannedStartTime'|'plannedEndTime'|'proposedCheckIn'|'proposedCheckOut'|'clockChanges'> & Partial<Pick<typeof attendanceCorrection.$inferSelect,'originalClockSnapshot'>>;
export type PolicySubmissionSourceRow=Omit<typeof attendancePolicyRequestContract.$inferSelect,'attestedWork'> & Partial<Pick<typeof attendancePolicyRequestContract.$inferSelect,'attestedWork'>>;
export type PolicyFinalReceiptSourceRow=typeof attendancePolicyFinalReceipt.$inferSelect;
/** The submission receipt chooses a routing contract; it does not prove a completed approval. */
function submissionSource(policy:ResolvedAttendanceGroupPolicy,row:PolicyApprovalSourceRow,contract:PolicySubmissionSourceRow|undefined){
 if(!contract)return {state:'missing' as const};
 if(contract.tenantId!==row.tenantId||contract.employmentId!==row.employmentId||contract.attendanceDate!==row.attendanceDate)
  return {state:'unavailable' as const,reason:'identityMismatch' as const};
 if(contract.kind==='epoch'?(contract.companyId!==policy.companyId||contract.visibleEpoch===null||!Number.isSafeInteger(contract.visibleEpoch)||contract.visibleEpoch<0)
  :contract.kind!=='unavailable'||contract.companyId!==null||contract.visibleEpoch!==null)
  return {state:'unavailable' as const,reason:'invalidContract' as const};
 return {state:'recorded' as const,correctionId:contract.correctionId,tenantId:contract.tenantId,employmentId:contract.employmentId,
  date:contract.attendanceDate,companyId:contract.companyId,kind:contract.kind,visibleEpoch:contract.visibleEpoch,manualApprovalMethod:contract.manualApprovalMethod,policyBinding:structuredClone(contract.policyBinding),recordedAt:contract.recordedAt.toISOString(),
  ...(contract.attestedWork?{attestedWork:structuredClone(contract.attestedWork)}:{})};
}
/** Only the DB transition owner can mint this row. Its retained decision/effect is still not a
 * positioned plan, exception attestation, current physical replay or payable policy calculation. */
function finalReceiptSource(policy:ResolvedAttendanceGroupPolicy,row:PolicyApprovalSourceRow,
 contract:PolicySubmissionSourceRow|undefined,receipt:PolicyFinalReceiptSourceRow|undefined){
 if(!receipt)return {state:'missing' as const};
 if(receipt.correctionId!==row.id||receipt.tenantId!==row.tenantId||receipt.employmentId!==row.employmentId
  ||receipt.attendanceDate!==row.attendanceDate||receipt.companyId!==policy.companyId)
  return {state:'unavailable' as const,reason:'identityMismatch' as const};
 if(!contract||contract.kind!=='epoch'||contract.correctionId!==row.id||contract.tenantId!==row.tenantId
  ||contract.employmentId!==row.employmentId||contract.attendanceDate!==row.attendanceDate||contract.companyId!==receipt.companyId
  ||contract.visibleEpoch!==receipt.submissionEpoch||!Number.isSafeInteger(receipt.submissionEpoch)||receipt.submissionEpoch<0
  ||receipt.authority!=='finalWorkflowDecisionOnly')return {state:'unavailable' as const,reason:'submissionMismatch' as const};
 if(contract.manualApprovalMethod!==row.otApprovalMethod||receipt.workflowEvidence?.submittedManualMethod!==contract.manualApprovalMethod
  ||!isDeepStrictEqual(receipt.workflowEvidence?.submittedPolicy??null,contract.policyBinding))
  return {state:'unavailable' as const,reason:'submissionMismatch' as const};
 if(contract.attestedWork&&(!isDeepStrictEqual(receipt.workflowEvidence?.submittedAttestedWork,contract.attestedWork)
  ||!isDeepStrictEqual(contract.attestedWork.work,row.originalClockSnapshot?.unclockedWork)))
  return {state:'unavailable' as const,reason:'submissionMismatch' as const};
 const request={requestedMinutes:row.requestedOtMinutes,approvedMinutes:row.approvedOtMinutes,method:row.otApprovalMethod,
  plannedStartLabel:row.plannedStartTime,plannedEndLabel:row.plannedEndTime,
  checkIn:row.proposedCheckIn,checkOut:row.proposedCheckOut,clockChanges:row.clockChanges};
 if(!isDeepStrictEqual(request,receipt.requestEvidence))return {state:'unavailable' as const,reason:'requestMismatch' as const};
 const workflow=receipt.workflowEvidence;
 if(!workflow||typeof workflow!=='object'||Array.isArray(workflow))return {state:'unavailable' as const,reason:'workflowMismatch' as const};
 const completion=workflow.completion as Record<string,unknown>|undefined;
 const participants=workflow.participants;
 if(workflow.requestId!==receipt.workflowRequestId||!Number.isSafeInteger(workflow.routingVersion)
  ||![2,3,4].includes(workflow.routingVersion as number)||!Number.isSafeInteger(workflow.stageCount)
  ||(workflow.stageCount as number)<1||(workflow.stageCount as number)>10||!completion||!Array.isArray(participants)
  ||completion.request_id!==receipt.workflowRequestId||completion.tenant_id!==row.tenantId
  ||completion.actual_user_id!==receipt.actorUserId||completion.stage_index!==(workflow.stageCount as number)-1
  ||completion.decision!=='approved'||completion.resulting_status!=='approved'
  ||!receipt.actorUserId||!(receipt.recordedAt instanceof Date)||!Number.isFinite(receipt.recordedAt.getTime()))
  return {state:'unavailable' as const,reason:'workflowMismatch' as const};
 if(workflow.routingVersion!==2&&!participants.some(p=>p&&typeof p==='object'
  &&p.request_id===receipt.workflowRequestId&&p.tenant_id===row.tenantId&&p.actual_user_id===receipt.actorUserId
  &&p.stage_index===(workflow.stageCount as number)-1&&p.decision==='approved'))
  return {state:'unavailable' as const,reason:'workflowMismatch' as const};
 if(row.status!=='approved'||row.cancelledAt!==null)return {state:'inactive' as const,reason:'requestNotApproved' as const};
 return {state:'recorded' as const,authority:'finalWorkflowDecisionOnly' as const,correctionId:receipt.correctionId,
  workflowRequestId:receipt.workflowRequestId,actorUserId:receipt.actorUserId,submissionEpoch:receipt.submissionEpoch,
  recordedAt:receipt.recordedAt.toISOString(),request:structuredClone(request),workflow:structuredClone(workflow),raw:structuredClone(receipt.rawEvidence)};
}
/** Newly issued dated submission + exact completed decision, not an inference from old labels.
 * This retains approved plan positions only. Current worked-day, policy binding, exclusions,
 * rounded count allocation and cash/TOIL replay are separate requirements. */
function positionedPlanSource(row:PolicyApprovalSourceRow,contract:PolicySubmissionSourceRow|undefined,
 receipt:PolicyFinalReceiptSourceRow|undefined,final:ReturnType<typeof finalReceiptSource>){
 const refuse=(reason:'submittedPlanMissing'|'finalDecisionUnavailable'|'submittedPlanMismatch'|'partialApprovalUnpositioned')=>
  ({state:'unavailable' as const,authority:'approvedPlanOnly' as const,reason});
 const plan=contract?.plannedWindow;
 if(!plan)return refuse('submittedPlanMissing');
 if(final.state!=='recorded'||!receipt)return refuse('finalDecisionUnavailable');
 // Database time columns serialize seconds. Only exact minute endpoints are a dated plan;
 // fractional seconds or a changed label must not be rounded into a different approved window.
 const label=(value:string|null)=>value&&/^([01]\d|2[0-3]):[0-5]\d:00$/.test(value)?value.slice(0,5):null;
 const start=label(row.plannedStartTime),end=label(row.plannedEndTime);
 const duration=start&&end?plannedOvertimeMinutes(start,end):null;
 if(duration===null||!start)return refuse('submittedPlanMismatch');
 const from=Number(start.slice(0,2))*60+Number(start.slice(3));
 const expected={version:1,basis:'startDateEarlierEndNextDay',sourceDate:row.attendanceDate,
  startLabel:row.plannedStartTime,endLabel:row.plannedEndTime,from,to:from+duration,requestedMinutes:duration};
 if(!isDeepStrictEqual(plan,expected)||!isDeepStrictEqual(receipt.workflowEvidence.submittedPlan,plan)
  ||row.requestedOtMinutes!==duration)return refuse('submittedPlanMismatch');
 // A scalar smaller approval cannot choose early/late minutes on the employee's behalf.
 if(row.approvedOtMinutes!==duration)return refuse('partialApprovalUnpositioned');
 return {state:'recorded' as const,authority:'approvedPlanOnly' as const,correctionId:row.id,
  workflowRequestId:receipt.workflowRequestId,companyId:receipt.companyId,sourceDate:row.attendanceDate,
  submissionEpoch:receipt.submissionEpoch,recordedAt:receipt.recordedAt.toISOString(),
  intervals:[{from,to:from+duration}],submittedPlan:structuredClone(expected)};
}
export function attendancePolicyApprovalInput(policy:ResolvedAttendanceGroupPolicy,rows:readonly PolicyApprovalSourceRow[],contracts:readonly PolicySubmissionSourceRow[]=[],receipts:readonly PolicyFinalReceiptSourceRow[]=[]){
 if(rows.length>500||contracts.length>500||receipts.length>500)throw Error('The policy approval source exceeds its bounded application history.');
 const ids=new Set(rows.map(row=>row.id)),byId=new Map(contracts.map(row=>[row.correctionId,row])),finalById=new Map(receipts.map(row=>[row.correctionId,row]));
 if(ids.size!==rows.length||byId.size!==contracts.length||finalById.size!==receipts.length
  ||contracts.some(row=>!ids.has(row.correctionId))||receipts.some(row=>!ids.has(row.correctionId)))throw Error('The policy submission source is ambiguous.');
 return {authority:'sourceOnly' as const,policyRevisionId:policy.id,mode:policy.policy.overtime.approval,
  autoMethod:policy.policy.overtime.autoMethod,activation:{...policy.activation},requests:rows.map(row=>{
  const contract=byId.get(row.id),receipt=finalById.get(row.id),final=finalReceiptSource(policy,row,contract,receipt);
  return ({
   id:row.id,submissionContract:submissionSource(policy,row,byId.get(row.id)),
   finalReceipt:final,positionedPlan:positionedPlanSource(row,contract,receipt,final),createdAt:row.createdAt.toISOString(),status:row.status,requestedMinutes:row.requestedOtMinutes,
   approvedMinutes:row.approvedOtMinutes,method:row.otApprovalMethod,decidedByEmploymentId:row.decidedByEmploymentId,
   decidedAt:row.decidedAt?.toISOString()??null,appliedAt:row.appliedAt?.toISOString()??null,cancelledAt:row.cancelledAt?.toISOString()??null,
   // Legacy Plan OT labels were saved as display/audit fields. Preserve them without promoting
   // their apparent interval to a new immutable approved physical window.
   plannedWindow:{authority:'auditOnly' as const,startLabel:row.plannedStartTime,endLabel:row.plannedEndTime},
  });})};
}
export type PolicyApprovalInput=ReturnType<typeof attendancePolicyApprovalInput>;
