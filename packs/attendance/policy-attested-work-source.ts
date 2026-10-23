/** Canonical transaction read for the explicit HR-work anchor. The link selects an identity;
 * the ordinary dated subject resolver selects policy before any retained evidence is checked. */
import {and,asc,desc,eq,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,attendanceCorrection,attendancePolicyRequestContract,attendancePolicyFinalReceipt,attendancePunch} from '../../db/schema';
import {attendancePolicyExecutionContextTx,type AttendancePolicyExecutionContext} from '../../core/attendance';
import {attendancePolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyAttestedWorkInput,type PolicyAttestedWorkSource} from './policy-attested-work-input';
import {attendancePolicyAttestedRawTrace} from '../../lib/attendance-policy-attested-trace';
export async function recordedAttestedPolicyWorkTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}){
 const context=await attendancePolicyExecutionContextTx(tx,ctx,p);
 if(context.state!=='policy')return null;
 return retainedAttestedPolicyWorkTx(tx,ctx,p,context);
}
/** Cancellation reduces an existing approval; changed current configuration must not trap
 * the original immutable HR statement. This read supplies no current financial authority.
 * Its context comes from the real linked anchor and must exactly match the private effect. */
export async function retainedAttestedPolicyCancellationTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}){
 const retained=await retainedAttestedPolicyWorkTx(tx,ctx,p);
 return retained?{authority:'retainedAttestedCancellationOnly' as const,
  attendanceId:retained.source.anchor.id,correctionId:retained.replay.correctionId}:null;
}
async function retainedAttestedPolicyWorkTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},currentContext?:AttendancePolicyExecutionContext){
 const [anchor]=await tx.select().from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
  eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
 if(!anchor?.attestedWorkCorrectionId)return null;
 const context=currentContext??anchor.attestedWorkContext as AttendancePolicyExecutionContext|undefined;
 if(context?.state!=='policy'||!context.selected)return null;
 const rows=await tx.select().from(attendanceCorrection).where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),
  eq(attendanceCorrection.employmentId,p.employmentId),eq(attendanceCorrection.attendanceDate,p.date)))
  .orderBy(desc(attendanceCorrection.decidedAt),desc(attendanceCorrection.createdAt),desc(attendanceCorrection.id)).limit(501);
 if(rows.length>500)return null;
 const otRows=rows.filter(row=>row.requestedOtMinutes!==null);
 const contracts=await tx.select().from(attendancePolicyRequestContract).where(and(eq(attendancePolicyRequestContract.tenantId,ctx.tenantId),
  eq(attendancePolicyRequestContract.employmentId,p.employmentId),eq(attendancePolicyRequestContract.attendanceDate,p.date)))
  .orderBy(asc(attendancePolicyRequestContract.correctionId)).limit(501);
 const receipts=await tx.select().from(attendancePolicyFinalReceipt).where(and(eq(attendancePolicyFinalReceipt.tenantId,ctx.tenantId),
  eq(attendancePolicyFinalReceipt.employmentId,p.employmentId),eq(attendancePolicyFinalReceipt.attendanceDate,p.date)))
  .orderBy(asc(attendancePolicyFinalReceipt.correctionId)).limit(501);
 const punches=await tx.select({id:attendancePunch.id}).from(attendancePunch).where(and(eq(attendancePunch.tenantId,ctx.tenantId),
  eq(attendancePunch.attendanceId,anchor.id),isNull(attendancePunch.voidedAt))).limit(1);
 const [effect]=await tx.execute(sql`select to_jsonb(e) as evidence from public.attendance_policy_attested_effect e
  where e.tenant_id=${ctx.tenantId}::uuid and e.correction_id=${anchor.attestedWorkCorrectionId}::uuid
   and e.attendance_id=${anchor.id}::uuid`) as unknown as {evidence:Record<string,unknown>}[];
 if(!effect)return null;
 const approvals=attendancePolicyApprovalInput(context.selected,otRows,contracts.filter(row=>otRows.some(request=>request.id===row.correctionId)),
  receipts.filter(row=>otRows.some(request=>request.id===row.correctionId)));
 // The independent calculation marker is written AFTER the work decision. It cannot change
 // immutable work identity or its replay digest, and cannot hide any other raw trace key.
 const rawAnchor={...anchor,calcTrace:attendancePolicyAttestedRawTrace(anchor.calcTrace)};
 const source:PolicyAttestedWorkSource={authority:'attestedSourceOnly',anchor:rawAnchor,punchCount:punches.length,ownerEffect:effect.evidence};
 const replay=attendancePolicyAttestedWorkInput(context,approvals,ctx.tenantId,source);
 const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
 return principal?.allowed&&replay.state==='known'?{context,source,replay,approvals}:null;
}
