/** Routing fence for the unfinished dated-policy execution owner. A configured policy must not
 * silently inherit an unrelated formula assignment or legacy overtime. This read cannot approve,
 * calculate or settle work. It uses the saved Attendance schedule and dated Personnel employer. */
import {and,asc,eq,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,attendanceGroupPolicyRevision} from '../../db/schema';
import {isAttendanceTrace} from '../../core/attendance-trace';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';

export async function hasRecordedAttendanceGroupPolicyTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}):Promise<boolean>{
 overtimeUuid(p.employmentId,'employmentId');overtimeDate(p.date,'attendanceDate');
 const current=async()=>{
  const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
  if(!principal?.allowed)throw Error('Current Attendance principal required.');
 };
 await current();
 const [day]=await tx.select({trace:attendance.calcTrace}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
  eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
 if(!day)return false;
 const trace=isAttendanceTrace(day.trace)?day.trace:null;
 // A recorded explicit absence of a Schedule Group is different from missing schedule evidence.
 if(trace&&trace.schedule.ruleId===null)return false;
 const ruleId=typeof trace?.schedule.ruleId==='string'?trace.schedule.ruleId:null;
 const proof=(await provenCompanyDatesTx(tx,[p])).get(p.employmentId+'|'+p.date);
 const [policy]=await tx.select({id:attendanceGroupPolicyRevision.id}).from(attendanceGroupPolicyRevision)
  .where(and(eq(attendanceGroupPolicyRevision.tenantId,ctx.tenantId),lte(attendanceGroupPolicyRevision.effectiveFrom,p.date),
   ruleId?eq(attendanceGroupPolicyRevision.ruleId,ruleId):undefined,
   proof?.companyId&&!proof.reason?eq(attendanceGroupPolicyRevision.companyId,proof.companyId):undefined))
  .orderBy(asc(attendanceGroupPolicyRevision.companyId),asc(attendanceGroupPolicyRevision.ruleId),asc(attendanceGroupPolicyRevision.ordinal)).limit(1);
 // A revoked policy read must never be reported as verified legacy absence.
 await current();
 return !!policy;
}
