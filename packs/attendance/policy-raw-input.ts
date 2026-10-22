/** Prospective raw-day inputs. This reader neither writes figures nor grants approval or payment. */
import {and,asc,eq,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,attendancePunch} from '../../db/schema';
import {attendancePolicyExecutionContextTx} from '../../core/attendance';
import {recordedPolicyClockSourceTx} from './policy-clock-input';
import {legacyApplicationForAttendancePolicyTx} from './policy-selection';
import {attendancePolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';
import {attendancePolicyClockMeasurements} from './policy-clock-measurements';
import {attendancePolicyWorkInput} from './policy-work-input';
import {assertModuleGate} from '../../core/module-gate';

/** Called only with the canonical writer's subject/date, never a posted policy/company/interval.
 * Resolve the actual schedule before a first raw-day trace exists; a pre-policy application keeps
 * its original owner. The complete effective punch set and original capture receipts remain intact.
 * Raw writers must still hold their ordinary Attendance/Payroll locks and serialize configuration. */
export async function attendancePolicyRawInputTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}){
 assertModuleGate(ctx,'attendance');
 const context=await attendancePolicyExecutionContextTx(tx,ctx,p);
 if(context.state!=='policy')return context;
 const applicationId=await legacyApplicationForAttendancePolicyTx(tx,ctx,p,context.selected);
 if(applicationId)return {state:'legacyApplication' as const,applicationId};
 const [day]=await tx.select({id:attendance.id}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
  eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
 if(!day)return {state:'unavailable' as const,reason:'rawDayUnavailable' as const};
 const punches=await tx.select().from(attendancePunch).where(and(eq(attendancePunch.tenantId,ctx.tenantId),
  eq(attendancePunch.attendanceId,day.id),isNull(attendancePunch.voidedAt))).orderBy(asc(attendancePunch.id)).limit(129);
 const source=await recordedPolicyClockSourceTx(tx,ctx,{attendanceId:day.id,employmentId:p.employmentId,date:p.date,punches});
 const clocks=source.state==='known'?attendancePolicyClockMillisecondEvidence(source.clocks,context.resolvedClock,4320):undefined;
 const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
 if(!principal?.allowed)throw Error('Current Attendance principal required.');
 return {state:'policy' as const,attendanceId:day.id,context,source,clocks,
  measurements:attendancePolicyClockMeasurements(context,clocks),work:attendancePolicyWorkInput(context,clocks)};
}
