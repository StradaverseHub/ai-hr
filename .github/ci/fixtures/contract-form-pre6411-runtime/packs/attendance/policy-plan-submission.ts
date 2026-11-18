import {isDeepStrictEqual} from 'node:util';
import {attendancePolicyPlanDates} from '../../lib/attendance-policy-plan-dates';
import {attendancePolicyTraceBinding} from './policy-trace-binding';
import {validateAttendanceGroupPolicy} from '../../lib/attendance-group-policy';
/** Source-only replay of the complete existing Auto approved-plan set. Submission
 * and withdrawal retain their own actor/action guards. The versioned final workflow
 * and current financial owners still own approval, work, count and settlement. */
import {and,asc,eq,inArray,isNull,isNotNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceCorrection,attendancePolicyRequestContract,attendancePolicyFinalReceipt,attendanceOvertimeSource,overtimeSourceSettlement,attendanceGroupPolicyRevision} from '../../db/schema';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import {attendancePolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyPlanInput} from './policy-plan-input';

export async function attendancePolicyCompleteApprovedPlanSetTx(tx:Tx,ctx:SessionContext,
 p:{employmentId:string;date:string},context:AttendancePolicyExecutionContext):Promise<boolean>{
 if(context.state!=='policy'||context.employmentId!==p.employmentId||context.date!==p.date
  ||context.selected.activation.epoch<1||!context.selected.policy.overtime.enabled
  ||context.selected.policy.overtime.approval!=='auto'||context.selected.policy.overtime.autoMethod==='actual')return false;
 const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
 if(!principal?.allowed)throw Error('Current Attendance principal required.');
 const [claim]=await tx.select({id:overtimeSourceSettlement.id}).from(overtimeSourceSettlement)
  .innerJoin(attendanceOvertimeSource,and(eq(attendanceOvertimeSource.id,overtimeSourceSettlement.sourceId),
   eq(attendanceOvertimeSource.tenantId,overtimeSourceSettlement.tenantId)))
  .where(and(eq(attendanceOvertimeSource.tenantId,ctx.tenantId),eq(attendanceOvertimeSource.employmentId,p.employmentId),
   eq(attendanceOvertimeSource.attendanceDate,p.date),isNull(overtimeSourceSettlement.releasedAt))).limit(1);
 if(claim)throw Error('Release the current unfinalized overtime settlement before changing the approved plan. Closed Payroll cannot be changed.');
 const rows=await tx.select().from(attendanceCorrection).where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),
  eq(attendanceCorrection.employmentId,p.employmentId),eq(attendanceCorrection.attendanceDate,p.date),
  eq(attendanceCorrection.status,'approved'),isNull(attendanceCorrection.cancelledAt),isNotNull(attendanceCorrection.requestedOtMinutes)))
  .orderBy(asc(attendanceCorrection.id)).limit(501);
 if(!rows.length||rows.length>=500)return false;
 // Every prior member must still be a complete immutable plan; no legacy/applied scalar
 // or unclocked testimony is silently promoted into this positioned union.
 if(rows.some(row=>row.appliedAt!==null||row.proposedCheckIn!==null||row.proposedCheckOut!==null||row.clockChanges!==null))return false;
 const ids=rows.map(row=>row.id);
 const [contracts,receipts]=await Promise.all([
  tx.select().from(attendancePolicyRequestContract).where(and(eq(attendancePolicyRequestContract.tenantId,ctx.tenantId),
   inArray(attendancePolicyRequestContract.correctionId,ids))).orderBy(asc(attendancePolicyRequestContract.correctionId)),
  tx.select().from(attendancePolicyFinalReceipt).where(and(eq(attendancePolicyFinalReceipt.tenantId,ctx.tenantId),
   inArray(attendancePolicyFinalReceipt.correctionId,ids))).orderBy(asc(attendancePolicyFinalReceipt.correctionId)),
 ]);
 const approvals=attendancePolicyApprovalInput(context.selected,rows,contracts,receipts);
 return attendancePolicyPlanInput(context,approvals,ctx.tenantId).state==='known';
}

/** Read immutable positions before taking configuration/Payroll locks. This only expands
 * the protected date set; it never proves an approval or supplies financial quantity. */
export async function attendancePolicyPlanProtectionDatesTx(tx:Tx,ctx:SessionContext,
 p:{employmentId:string;date:string},context:AttendancePolicyExecutionContext,additional?:{from:number;to:number}):Promise<string[]>{
 if(context.state!=='policy'||context.employmentId!==p.employmentId||context.date!==p.date
  ||context.selected.activation.epoch<1||!context.selected.policy.overtime.enabled||context.selected.policy.overtime.approval!=='auto'
  ||context.selected.policy.overtime.autoMethod==='actual')return [p.date];
 const rows=await tx.select({window:attendancePolicyRequestContract.plannedWindow,binding:attendancePolicyRequestContract.policyBinding})
  .from(attendanceCorrection).innerJoin(attendancePolicyRequestContract,and(
   eq(attendancePolicyRequestContract.correctionId,attendanceCorrection.id),eq(attendancePolicyRequestContract.tenantId,attendanceCorrection.tenantId)))
  .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.employmentId,p.employmentId),
   eq(attendanceCorrection.attendanceDate,p.date),inArray(attendanceCorrection.status,['approved','pending']),
   isNull(attendanceCorrection.cancelledAt),isNotNull(attendanceCorrection.requestedOtMinutes),
   sql`${attendancePolicyRequestContract.policyBinding}->>'revisionId'=${context.selected.id}`))
  .orderBy(asc(attendanceCorrection.id)).limit(501);
 if(rows.length>500)throw Error('The complete planned date scope is unavailable.');
 const binding=attendancePolicyTraceBinding(context),windows:{from:number;to:number}[]=[];
 for(const row of rows){
  const plan=row.window;
  if(!binding||!isDeepStrictEqual(row.binding,binding)||!plan||plan.sourceDate!==p.date
   ||plan.version!==1||plan.basis!=='startDateEarlierEndNextDay'
   ||typeof plan.from!=='number'||typeof plan.to!=='number')throw Error('The submitted plan date scope changed.');
  windows.push({from:plan.from,to:plan.to});
 }
 if(additional)windows.push({...additional});
 return attendancePolicyPlanDates(p.date,windows);
}

/** Withdrawal-only identity from the original immutable revision and completed workflow.
 * Current policy may differ. This does not return quantity, duration, cash or a work
 * witness, and may never be used by the current financial/credit admission owners. */
export async function retainedAttendancePolicyPlanCancellationTx(tx:Tx,ctx:SessionContext,
 p:{correctionId:string;employmentId:string;date:string}){
 const [row]=await tx.select().from(attendanceCorrection).where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),
  eq(attendanceCorrection.id,p.correctionId),eq(attendanceCorrection.employmentId,p.employmentId),
  eq(attendanceCorrection.attendanceDate,p.date))).limit(1);
 const [contract]=await tx.select().from(attendancePolicyRequestContract).where(and(eq(attendancePolicyRequestContract.tenantId,ctx.tenantId),
  eq(attendancePolicyRequestContract.correctionId,p.correctionId))).limit(1);
 const binding=contract?.policyBinding;
 if(!row||!binding||!contract.plannedWindow||contract.attestedWork)return null;
 const [revision]=await tx.select().from(attendanceGroupPolicyRevision).where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),
  eq(attendanceGroupPolicyRevision.id,binding.revisionId))).limit(1);
 if(!revision)throw Error('The original approved-plan policy is unavailable.');
 const policy=validateAttendanceGroupPolicy(revision.policy,4320);
 if(!policy.overtime.enabled||policy.overtime.approval!=='auto'||policy.overtime.autoMethod==='actual')return null;
 const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
 if(!principal?.allowed)throw Error('Current Attendance principal required.');
 const selected={id:revision.id,companyId:revision.companyId,ruleId:revision.ruleId,ordinal:revision.ordinal,
  effectiveFrom:revision.effectiveFrom,policy,activation:{epoch:revision.activationEpoch,actorUserId:revision.createdByUserId,
   recordedAt:revision.createdAt.toISOString(),reason:revision.reason}};
 const expected={authority:'datedPolicyOnly',sourceDate:p.date,employmentId:p.employmentId,companyId:selected.companyId,
  revisionId:selected.id,ruleId:selected.ruleId,ordinal:selected.ordinal,effectiveFrom:selected.effectiveFrom,
  activation:{epoch:selected.activation.epoch,actorUserId:selected.activation.actorUserId,recordedAt:selected.activation.recordedAt},pairing:binding.pairing};
 const [receipt]=await tx.select().from(attendancePolicyFinalReceipt).where(and(eq(attendancePolicyFinalReceipt.tenantId,ctx.tenantId),
  eq(attendancePolicyFinalReceipt.correctionId,p.correctionId))).limit(1);
 const approval=attendancePolicyApprovalInput(selected,[row],[contract],receipt?[receipt]:[]).requests[0];
 const submission=approval.submissionContract;
 if(row.status!=='approved'||row.cancelledAt!==null||row.appliedAt!==null||row.proposedCheckIn!==null||row.proposedCheckOut!==null
  ||row.clockChanges!==null||!['auto','firstInLastOut'].includes(binding.pairing)||!Number.isSafeInteger(revision.activationEpoch)||revision.activationEpoch<1
  ||selected.effectiveFrom>p.date||!isDeepStrictEqual(binding,expected)||submission.state!=='recorded'||submission.kind!=='epoch'
  ||submission.visibleEpoch===null||submission.visibleEpoch<revision.activationEpoch
  ||approval.finalReceipt.state!=='recorded'||approval.positionedPlan.state!=='recorded'
  ||Date.parse(submission.recordedAt)<revision.createdAt.getTime()
  ||Date.parse(approval.finalReceipt.recordedAt)<Date.parse(submission.recordedAt))
  throw Error('The original approved-plan workflow and submitted positions cannot be verified.');
 // An overlap union can redistribute dated counts when one request is removed.
 // Protect every immutable active planned date, without granting those rows approval.
 const rows=await tx.select({window:attendancePolicyRequestContract.plannedWindow})
  .from(attendanceCorrection).innerJoin(attendancePolicyRequestContract,and(
   eq(attendancePolicyRequestContract.correctionId,attendanceCorrection.id),eq(attendancePolicyRequestContract.tenantId,attendanceCorrection.tenantId)))
  .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.employmentId,p.employmentId),
   eq(attendanceCorrection.attendanceDate,p.date),inArray(attendanceCorrection.status,['approved','pending']),
   isNull(attendanceCorrection.cancelledAt),isNotNull(attendancePolicyRequestContract.plannedWindow)))
  .orderBy(asc(attendanceCorrection.id)).limit(501);
 if(rows.length>500)throw Error('The complete retained plan date scope is unavailable.');
 const windows=rows.map(({window})=>{
  if(!window||window.sourceDate!==p.date||window.version!==1||window.basis!=='startDateEarlierEndNextDay'
   ||typeof window.from!=='number'||typeof window.to!=='number')throw Error('The retained plan date scope is unavailable.');
  return {from:window.from,to:window.to};
 });
 windows.push(...approval.positionedPlan.intervals.map(span=>({...span})));
 return {authority:'retainedPlanCancellationOnly' as const,correctionId:p.correctionId,
  protectedDates:attendancePolicyPlanDates(p.date,windows)};
}
