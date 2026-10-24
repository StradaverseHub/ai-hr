import {withTenant,type SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {isModuleEnabled} from './entitlements';
import {ownClockTodaySummary,workedDayKindForTx,employeeClockingLocationLabels} from '../packs/attendance/service';
import {approvedLeavePresenceByEmploymentTx} from '../packs/leave/service';
import {readOwnPayrollHomeMetadata} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeToday} from '../lib/employee-home-today';

/** Independent own facts only. Displaying this projection cannot capture location, clock a person,
 * change attendance/leave/payroll policy, or declare that a bank payment occurred. */
export async function readEmployeeHomeToday(ctx:SessionContext,employmentId:string):Promise<EmployeeHomeToday>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 const attendanceEnabled=isModuleEnabled(ctx,'attendance'),payrollEnabled=isModuleEnabled(ctx,'payroll');
 const [clock,payroll]=await Promise.all([
  attendanceEnabled?ownClockTodaySummary(ctx,subject.employmentId):Promise.resolve(null),
  payrollEnabled?readOwnPayrollHomeMetadata(ctx,subject.employmentId):Promise.resolve(null),
 ]);
 const serverNow=clock?.serverNow??new Date().toISOString(),businessDate=todayInKualaLumpur(new Date(serverNow));
 let dayKind:EmployeeHomeToday['dayKind']=null,leavePresence:EmployeeHomeToday['leavePresence']=null;
 let workLocations:EmployeeHomeToday['workLocations']={total:0,names:[]};
 if(clock){
  const [kind,presence,locations]=await Promise.all([
   withTenant(ctx,tx=>workedDayKindForTx(tx,subject.employmentId,businessDate)),
   withTenant(ctx,tx=>approvedLeavePresenceByEmploymentTx(tx,[subject.employmentId],businessDate,businessDate)),
   employeeClockingLocationLabels(ctx,subject.employmentId),
  ]);
  dayKind=kind;leavePresence=presence.get(subject.employmentId)?.get(businessDate)??null;workLocations=locations;
 }
 const payment=payroll?.nextPayment;
 return {version:1,employmentId:subject.employmentId,serverNow,businessDate,attendanceEnabled,payrollEnabled,
  clock:clock?{date:clock.date,clockedIn:clock.clockedIn,openSince:clock.openSince,workedSeconds:clock.workedSeconds,
   crossesMidnight:clock.crossesMidnight,shift:{code:clock.shift.code,start:clock.shift.start,end:clock.shift.end},
   geofencingRequired:clock.geofencingRequired,photoRequired:clock.attendancePhotoSetting==='required'}:null,
  dayKind,leavePresence,workLocations,
  payday:payment?{date:payment.date,daysAway:Math.round((Date.parse(payment.date+'T00:00:00Z')-Date.parse(businessDate+'T00:00:00Z'))/86400000)}:null};
}
