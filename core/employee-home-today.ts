import {withTenant,type SessionContext} from '../db/client';
import {settleReadGroup} from '../lib/settle-read-group';
import {HomeAccessError,requireSelectedOwnHomeEmploymentIdTx} from './employee-home';
import {isModuleEnabled} from './entitlements';
import {ownClockTodaySummaryTx,employeeClockingLocationLabelsTx} from '../packs/attendance/service';
import {approvedLeavePresenceByEmploymentTx} from '../packs/leave/service';
import {readOwnNextPayrollPaymentDate} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeToday} from '../lib/employee-home-today';

/** Independent own facts only. Displaying this projection cannot capture location, clock a person,
 * change attendance/leave/payroll policy, or declare that a bank payment occurred. */
export async function readEmployeeHomeToday(ctx:SessionContext,employmentId:string,signal?:AbortSignal):Promise<EmployeeHomeToday>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 const {subjectId,attendanceEnabled,payrollEnabled,attendance}=await withTenant(ctx,async tx=>{
  const subjectId=await requireSelectedOwnHomeEmploymentIdTx(tx,ctx,employmentId);
  signal?.throwIfAborted();
  const attendanceEnabled=isModuleEnabled(ctx,'attendance'),payrollEnabled=isModuleEnabled(ctx,'payroll');
  if(!attendanceEnabled)return {subjectId,attendanceEnabled,payrollEnabled,attendance:null};
  const clock=await ownClockTodaySummaryTx(tx,ctx,subjectId);
  signal?.throwIfAborted();
  const {businessDate,dayKind}=clock;
  const [presence,workLocations]=await settleReadGroup([
   ()=>approvedLeavePresenceByEmploymentTx(tx,[subjectId],businessDate,businessDate),
   ()=>employeeClockingLocationLabelsTx(tx,subjectId),
  ]);
  return {subjectId,attendanceEnabled,payrollEnabled,
   attendance:{clock,businessDate,dayKind,leavePresence:presence.get(subjectId)?.get(businessDate)??null,workLocations}};
 },{readOnlySnapshot:true,readSignal:signal});
 signal?.throwIfAborted();
 const paymentDate=payrollEnabled?await readOwnNextPayrollPaymentDate(ctx,subjectId,signal):null;
 const clock=attendance?.clock??null;
 const serverNow=clock?.serverNow??new Date().toISOString();
 const businessDate=attendance?.businessDate??todayInKualaLumpur(new Date(serverNow));
 return {version:1,employmentId:subjectId,serverNow,businessDate,attendanceEnabled,payrollEnabled,
  clock:clock?{date:clock.date,clockedIn:clock.clockedIn,openSince:clock.openSince,workedSeconds:clock.workedSeconds,
   crossesMidnight:clock.crossesMidnight,shift:{code:clock.shift.code,start:clock.shift.start,end:clock.shift.end},
   geofencingRequired:clock.geofencingRequired,photoRequired:clock.attendancePhotoSetting==='required'}:null,
  dayKind:attendance?.dayKind??null,leavePresence:attendance?.leavePresence??null,
  workLocations:attendance?.workLocations??{total:0,names:[]},
  payday:paymentDate?{date:paymentDate,daysAway:Math.round((Date.parse(paymentDate+'T00:00:00Z')-Date.parse(businessDate+'T00:00:00Z'))/86400000)}:null};
}
