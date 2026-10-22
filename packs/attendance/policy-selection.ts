/** Routing fence for the unfinished dated-policy execution owner. A configured policy must not
 * silently inherit an unrelated formula assignment or legacy overtime. This read cannot approve,
 * calculate or settle work. It uses the saved Attendance schedule and dated Personnel employer. */
import {and,asc,desc,eq,inArray,isNotNull,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,attendanceCorrection,attendanceGroupPolicyRevision,attendancePolicyRequestContract} from '../../db/schema';
import {isAttendanceTrace} from '../../core/attendance-trace';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {attendanceGroupPolicyOnTx,type ResolvedAttendanceGroupPolicy} from '../../core/attendance-group-policy';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';

/** Shared frozen-application admission for recorded and prospective raw-day selection.
 * The caller must supply a policy resolved by the canonical subject/date/company owner. */
export async function legacyApplicationForAttendancePolicyTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},selected:ResolvedAttendanceGroupPolicy):Promise<string|null>{
 const [application]=await tx.select({id:attendanceCorrection.id,
    predatesPolicy:sql<boolean>`(
     (${attendancePolicyRequestContract.correctionId} is null or(${attendancePolicyRequestContract.kind}='epoch'
       and ${attendancePolicyRequestContract.companyId}=${selected.companyId}::uuid
       and ${attendancePolicyRequestContract.employmentId}=${attendanceCorrection.employmentId}
       and ${attendancePolicyRequestContract.attendanceDate}=${attendanceCorrection.attendanceDate}))
     and not exists(select 1 from public.attendance_group_policy_revision prior
      where prior.tenant_id=${ctx.tenantId}::uuid and prior.company_id=${selected.companyId}::uuid and prior.rule_id=${selected.ruleId}::uuid
       and prior.effective_from<=${p.date}::date and prior.activation_epoch<=coalesce(${attendancePolicyRequestContract.visibleEpoch},0)))`})
    .from(attendanceCorrection).leftJoin(attendancePolicyRequestContract,and(eq(attendancePolicyRequestContract.correctionId,attendanceCorrection.id),eq(attendancePolicyRequestContract.tenantId,ctx.tenantId)))
    .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.employmentId,p.employmentId),
     eq(attendanceCorrection.attendanceDate,p.date),isNotNull(attendanceCorrection.requestedOtMinutes),inArray(attendanceCorrection.status,['approved','pending'])))
    .orderBy(sql`case when ${attendanceCorrection.status}='approved' then 0 else 1 end`,desc(attendanceCorrection.decidedAt),desc(attendanceCorrection.createdAt),desc(attendanceCorrection.id)).limit(1);
 const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
 if(!principal?.allowed)throw Error('Current Attendance principal required.');
 return application?.predatesPolicy?application.id:null;
}

export type RecordedAttendanceGroupPolicySelection={state:'none'}|{state:'unavailable'}|{state:'legacyApplication';applicationId:string}|{state:'policy';selected:ResolvedAttendanceGroupPolicy};
export async function recordedAttendanceGroupPolicyTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}):Promise<RecordedAttendanceGroupPolicySelection>{
 overtimeUuid(p.employmentId,'employmentId');overtimeDate(p.date,'attendanceDate');
 const current=async()=>{
  const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
  if(!principal?.allowed)throw Error('Current Attendance principal required.');
 };
 await current();
 const [day]=await tx.select({trace:attendance.calcTrace}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
  eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
 if(!day)return {state:'none'};
 const trace=isAttendanceTrace(day.trace)?day.trace:null;
 // A recorded explicit absence of a Schedule Group is different from missing schedule evidence.
 if(trace&&trace.schedule.ruleId===null)return {state:'none'};
 const ruleId=typeof trace?.schedule.ruleId==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(trace.schedule.ruleId)?trace.schedule.ruleId:null;
 const proof=(await provenCompanyDatesTx(tx,[p])).get(p.employmentId+'|'+p.date);
 if(ruleId&&proof?.companyId&&!proof.reason){
  const selected=await attendanceGroupPolicyOnTx(tx,ctx,{companyId:proof.companyId,ruleId,date:p.date});
  if(selected){
   // Existing submitted work keeps its original approval contract. Choose the SAME effective
   // approved request (or pending request if none is approved) as the legacy landing owner; an
   // older superseded approval must not keep a newer application in legacy mode forever.
   // The immutable owner-issued receipt records the serialized company policy epoch. Missing
   // receipts identify pre-0590 requests; epoch-zero policies conservatively keep those out of
   // legacy mode. An unavailable/mismatched receipt is never permission for legacy payment.
   const legacyApplicationId=await legacyApplicationForAttendancePolicyTx(tx,ctx,p,selected);
   await current();
   if(legacyApplicationId)return {state:'legacyApplication',applicationId:legacyApplicationId};
  }
  await current();
  return selected?{state:'policy',selected}:{state:'none'};
 }
 const [policy]=await tx.select({id:attendanceGroupPolicyRevision.id}).from(attendanceGroupPolicyRevision)
  .where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),lte(attendanceGroupPolicyRevision.effectiveFrom,p.date),
   ruleId?eq(attendanceGroupPolicyRevision.ruleId,ruleId):undefined,
   proof?.companyId&&!proof.reason?eq(attendanceGroupPolicyRevision.companyId,proof.companyId):undefined))
  .orderBy(asc(attendanceGroupPolicyRevision.companyId),asc(attendanceGroupPolicyRevision.ruleId),asc(attendanceGroupPolicyRevision.ordinal)).limit(1);
 // A revoked policy read must never be reported as verified legacy absence.
 await current();
 return policy?{state:'unavailable'}:{state:'none'};
}

export async function hasRecordedAttendanceGroupPolicyTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}):Promise<boolean>{
 const selected=await recordedAttendanceGroupPolicyTx(tx,ctx,p);
 return selected.state==='policy'||selected.state==='unavailable';
}
