import {withTenant,type SessionContext} from '../db/client';
import {HomeAccessError,requireSelectedOwnHomeEmploymentIdTx} from './employee-home';
import {isModuleEnabled} from './entitlements';
import {ownClockTodayHomeTx} from '../packs/attendance/service';
import {approvedLeavePresenceByEmploymentTx} from '../packs/leave/service';
import {readOwnNextPayrollPaymentDate,type OwnHomePayrollRead} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeToday} from '../lib/employee-home-today';

/** Independent own facts only. Displaying this projection cannot capture location, clock a person,
 * change attendance/leave/payroll policy, or declare that a bank payment occurred. */
export async function readEmployeeHomeToday(ctx:SessionContext,employmentId:string,signal?:AbortSignal,payrollRead?:OwnHomePayrollRead):Promise<EmployeeHomeToday>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 const {subjectId,attendanceEnabled,payrollEnabled,attendance}=await withTenant(ctx,async tx=>{
  const subjectId=await requireSelectedOwnHomeEmploymentIdTx(tx,ctx,employmentId);
  signal?.throwIfAborted();
  const attendanceEnabled=isModuleEnabled(ctx,'attendance'),payrollEnabled=isModuleEnabled(ctx,'payroll');
  if(!attendanceEnabled)return {subjectId,attendanceEnabled,payrollEnabled,attendance:null};
  // The own clock summary, the work location names and the calendar window of yesterday and today (holidays,
  // replacement days, leave presence) come from one bundled read of the clock day (draft 9870 and
  // core/calendar-window-inputs.ts); inside a Home stream the stream's one calendar window answers the calendar part.
  // The approved leave presence of the business date is the presence owner's own answer over those rows.
  const {clock,workLocations,calendar}=await ownClockTodayHomeTx(tx,ctx,subjectId);
  signal?.throwIfAborted();
  const {businessDate,dayKind}=clock;
  const presence=await approvedLeavePresenceByEmploymentTx(tx,[subjectId],businessDate,businessDate,calendar);
  return {subjectId,attendanceEnabled,payrollEnabled,
   attendance:{clock,businessDate,dayKind,leavePresence:presence.get(subjectId)?.get(businessDate)??null,workLocations}};
 },{readOnlySnapshot:true,readSignal:signal});
 signal?.throwIfAborted();
 const paymentDate=payrollEnabled?await (payrollRead?payrollRead.nextPaymentDate(ctx,subjectId):readOwnNextPayrollPaymentDate(ctx,subjectId,signal)):null;
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
