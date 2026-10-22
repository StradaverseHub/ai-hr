/** Existing application facts are source evidence, never a new final-effect capability. */
import type {attendanceCorrection} from '../../db/schema';
import type {ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';

export type PolicyApprovalSourceRow=Pick<typeof attendanceCorrection.$inferSelect,'id'|'createdAt'|'status'|'requestedOtMinutes'|'approvedOtMinutes'|'otApprovalMethod'|'decidedByEmploymentId'|'decidedAt'|'appliedAt'|'cancelledAt'|'plannedStartTime'|'plannedEndTime'>;
export function attendancePolicyApprovalInput(policy:ResolvedAttendanceGroupPolicy,rows:readonly PolicyApprovalSourceRow[]){
 if(rows.length>500)throw Error('The policy approval source exceeds its bounded application history.');
 return {authority:'sourceOnly' as const,policyRevisionId:policy.id,mode:policy.policy.overtime.approval,
  autoMethod:policy.policy.overtime.autoMethod,activation:{...policy.activation},requests:rows.map(row=>({
   id:row.id,createdAt:row.createdAt.toISOString(),status:row.status,requestedMinutes:row.requestedOtMinutes,
   approvedMinutes:row.approvedOtMinutes,method:row.otApprovalMethod,decidedByEmploymentId:row.decidedByEmploymentId,
   decidedAt:row.decidedAt?.toISOString()??null,appliedAt:row.appliedAt?.toISOString()??null,cancelledAt:row.cancelledAt?.toISOString()??null,
   // Legacy Plan OT labels were saved as display/audit fields. Preserve them without promoting
   // their apparent interval to a new immutable approved physical window.
   plannedWindow:{authority:'auditOnly' as const,startLabel:row.plannedStartTime,endLabel:row.plannedEndTime},
  }))};
}
export type PolicyApprovalInput=ReturnType<typeof attendancePolicyApprovalInput>;
