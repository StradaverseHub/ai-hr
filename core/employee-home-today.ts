import {withTenant,type SessionContext} from '../db/client';
import {requireSelectedOwnHomeEmploymentId} from './employee-home';
import {isModuleEnabled} from './entitlements';
import {ownClockTodaySummaryTx,workedDayKindForTx,employeeClockingLocationLabelsTx} from '../packs/attendance/service';
import {approvedLeavePresenceByEmploymentTx} from '../packs/leave/service';
import {readOwnNextPayrollPaymentDate} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeToday} from '../lib/employee-home-today';

/** Independent own facts only. Displaying this projection cannot capture location, clock a person,
 * change attendance/leave/payroll policy, or declare that a bank payment occurred. */
export async function readEmployeeHomeToday(ctx:SessionContext,employmentId:string):Promise<EmployeeHomeToday>{
 const subjectId=await requireSelectedOwnHomeEmploymentId(ctx,employmentId);
 const attendanceEnabled=isModuleEnabled(ctx,'attendance'),payrollEnabled=isModuleEnabled(ctx,'payroll');
 const [attendance,paymentDate]=await Promise.all([
  attendanceEnabled?withTenant(ctx,async tx=>{
   const clock=await ownClockTodaySummaryTx(tx,ctx,subjectId);
   const businessDate=todayInKualaLumpur(new Date(clock.serverNow));
   const [dayKind,presence,workLocations]=await Promise.all([
    workedDayKindForTx(tx,subjectId,businessDate),
    approvedLeavePresenceByEmploymentTx(tx,[subjectId],businessDate,businessDate),
    employeeClockingLocationLabelsTx(tx,subjectId),
   ]);
   return {clock,businessDate,dayKind,leavePresence:presence.get(subjectId)?.get(businessDate)??null,workLocations};
  }):null,
  payrollEnabled?readOwnNextPayrollPaymentDate(ctx,subjectId):null,
 ]);
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
