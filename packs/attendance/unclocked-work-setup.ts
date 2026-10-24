import {attendancePolicyAttestedRawTrace} from '../../lib/attendance-policy-attested-trace';
/** Form availability only. Submission/final decision independently recheck all authority,
 * policy, absence-of-captures, source/epoch and financial protections. */
import {and,eq,isNull,sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {withAttendanceTenant} from '../../core/module-gate';
import {attendance,attendancePunch,employment} from '../../db/schema';
import {attendancePolicyExecutionContextTx} from '../../core/attendance';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
export async function canSubmitUnclockedAttendanceWork(ctx:SessionContext,employmentId:string,date:string):Promise<boolean>{
 overtimeUuid(employmentId,'employmentId');overtimeDate(date,'attendanceDate');
 if(date>todayInKualaLumpur())return false;
 return withAttendanceTenant(ctx,async tx=>{
  const [subject]=await tx.select({allowed:sql<boolean>`app.can_admin_employment(${employment.id})`,own:sql<boolean>`app.is_self_person(${employment.personId})`})
   .from(employment).where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId))).limit(1);
  if(!subject?.allowed||subject.own)return false;
  const context=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId,date});
  if(context.state!=='policy'||!context.selected.policy.overtime.enabled||!context.selected.policy.overtime.allowBackdatedWithoutClock
   ||context.selected.activation.epoch<1||context.placement.state!=='known')return false;
  const [day]=await tx.select().from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,employmentId),eq(attendance.attendanceDate,date))).limit(1);
  if(day){
   if(day.attestedWorkCorrectionId||[day.checkInAt,day.checkOutAt,attendancePolicyAttestedRawTrace(day.calcTrace),day.workedMinutes,day.otMinutes,day.lateMinutes,day.earlyOutMinutes,
    day.underMinutes,day.lateDeductMinutes,day.earlyOutDeductMinutes,day.otFlatMinutes,day.ot00Minutes,day.ot10Minutes,day.ot15Minutes,day.ot20Minutes,day.ot30Minutes].some(value=>value!==null))return false;
   const punches=await tx.select({id:attendancePunch.id}).from(attendancePunch).where(and(eq(attendancePunch.tenantId,ctx.tenantId),eq(attendancePunch.attendanceId,day.id),isNull(attendancePunch.voidedAt))).limit(1);
   if(punches.length)return false;
  }
  const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
  return principal?.allowed===true;
 });
}
