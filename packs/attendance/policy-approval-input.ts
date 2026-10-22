/** Existing application facts are source evidence, never a new final-effect capability. */
import type {attendanceCorrection,attendancePolicyRequestContract} from '../../db/schema';
import type {ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';

export type PolicyApprovalSourceRow=Pick<typeof attendanceCorrection.$inferSelect,'id'|'tenantId'|'employmentId'|'attendanceDate'|'createdAt'|'status'|'requestedOtMinutes'|'approvedOtMinutes'|'otApprovalMethod'|'decidedByEmploymentId'|'decidedAt'|'appliedAt'|'cancelledAt'|'plannedStartTime'|'plannedEndTime'>;
export type PolicySubmissionSourceRow=typeof attendancePolicyRequestContract.$inferSelect;
/** The submission receipt chooses a routing contract; it does not prove a completed approval. */
function submissionSource(policy:ResolvedAttendanceGroupPolicy,row:PolicyApprovalSourceRow,contract:PolicySubmissionSourceRow|undefined){
 if(!contract)return {state:'missing' as const};
 if(contract.tenantId!==row.tenantId||contract.employmentId!==row.employmentId||contract.attendanceDate!==row.attendanceDate)
  return {state:'unavailable' as const,reason:'identityMismatch' as const};
 if(contract.kind==='epoch'?(contract.companyId!==policy.companyId||contract.visibleEpoch===null||!Number.isSafeInteger(contract.visibleEpoch)||contract.visibleEpoch<0)
  :contract.kind!=='unavailable'||contract.companyId!==null||contract.visibleEpoch!==null)
  return {state:'unavailable' as const,reason:'invalidContract' as const};
 return {state:'recorded' as const,correctionId:contract.correctionId,tenantId:contract.tenantId,employmentId:contract.employmentId,
  date:contract.attendanceDate,companyId:contract.companyId,kind:contract.kind,visibleEpoch:contract.visibleEpoch,recordedAt:contract.recordedAt.toISOString()};
}
export function attendancePolicyApprovalInput(policy:ResolvedAttendanceGroupPolicy,rows:readonly PolicyApprovalSourceRow[],contracts:readonly PolicySubmissionSourceRow[]=[]){
 if(rows.length>500||contracts.length>500)throw Error('The policy approval source exceeds its bounded application history.');
 const ids=new Set(rows.map(row=>row.id)),byId=new Map(contracts.map(row=>[row.correctionId,row]));
 if(ids.size!==rows.length||byId.size!==contracts.length||contracts.some(row=>!ids.has(row.correctionId)))throw Error('The policy submission source is ambiguous.');
 return {authority:'sourceOnly' as const,policyRevisionId:policy.id,mode:policy.policy.overtime.approval,
  autoMethod:policy.policy.overtime.autoMethod,activation:{...policy.activation},requests:rows.map(row=>({
   id:row.id,submissionContract:submissionSource(policy,row,byId.get(row.id)),createdAt:row.createdAt.toISOString(),status:row.status,requestedMinutes:row.requestedOtMinutes,
   approvedMinutes:row.approvedOtMinutes,method:row.otApprovalMethod,decidedByEmploymentId:row.decidedByEmploymentId,
   decidedAt:row.decidedAt?.toISOString()??null,appliedAt:row.appliedAt?.toISOString()??null,cancelledAt:row.cancelledAt?.toISOString()??null,
   // Legacy Plan OT labels were saved as display/audit fields. Preserve them without promoting
   // their apparent interval to a new immutable approved physical window.
   plannedWindow:{authority:'auditOnly' as const,startLabel:row.plannedStartTime,endLabel:row.plannedEndTime},
  }))};
}
export type PolicyApprovalInput=ReturnType<typeof attendancePolicyApprovalInput>;
