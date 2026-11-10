/** The Home Time Off and Today card owners exactly as they read before the per-card bundles (59ecae315): every staged
 * owner statement, the same authority, the same composition. Equivalence tests compare the shipped owners with these.
 * Test-only: nothing in the application imports this file. */
import {withTenant,type SessionContext} from '../../db/client';
import {settleReadGroup} from '../../lib/settle-read-group';
import {hasEligibleLeaveTypeForTx} from '../../core/read';
import {HomeAccessError,requireActiveOwnHomeSnapshotEmploymentIdTx,requireSelectedOwnHomeEmploymentIdTx} from '../../core/employee-home';
import {isModuleEnabled} from '../../core/entitlements';
import {myCurrentLeaveSnapshotCards,nextApprovedLeavePresenceTx,approvedLeavePresenceByEmploymentTx} from '../../packs/leave/service';
import {ownClockTodaySummaryTx,employeeClockingLocationLabelsTx} from '../../packs/attendance/service';
import {readOwnNextPayrollPaymentDate} from '../../packs/payroll/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../../lib/employee-home-read-model';
import type {EmployeeHomeToday} from '../../lib/employee-home-today';

export async function stagedHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string):Promise<EmployeeHomeTimeOff>{
 return withTenant(ctx,async tx=>{
  const subjectId=await requireActiveOwnHomeSnapshotEmploymentIdTx(tx,ctx,employmentId);
  const today=todayInKualaLumpur();
  const [cards,nextApproved,eligible]=await settleReadGroup([
   ()=>myCurrentLeaveSnapshotCards(ctx,subjectId,{today,locale},tx),
   ()=>nextApprovedLeavePresenceTx(tx,subjectId,today),
   ()=>hasEligibleLeaveTypeForTx(tx,subjectId),
  ]);
  if(cards.length>100)throw Error('Own leave catalogue exceeds its supported Home limit.');
  return {version:1,employmentId:subjectId,asOf:today,canApply:eligible,
   balances:cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})),
   nextApproved};
 },{readOnlySnapshot:true});
}

export async function stagedHomeToday(ctx:SessionContext,employmentId:string):Promise<EmployeeHomeToday>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 const {subjectId,attendanceEnabled,payrollEnabled,attendance}=await withTenant(ctx,async tx=>{
  const subjectId=await requireSelectedOwnHomeEmploymentIdTx(tx,ctx,employmentId);
  const attendanceEnabled=isModuleEnabled(ctx,'attendance'),payrollEnabled=isModuleEnabled(ctx,'payroll');
  if(!attendanceEnabled)return {subjectId,attendanceEnabled,payrollEnabled,attendance:null};
  const clock=await ownClockTodaySummaryTx(tx,ctx,subjectId);
  const {businessDate,dayKind}=clock;
  const [presence,workLocations]=await settleReadGroup([
   ()=>approvedLeavePresenceByEmploymentTx(tx,[subjectId],businessDate,businessDate),
   ()=>employeeClockingLocationLabelsTx(tx,subjectId),
  ]);
  return {subjectId,attendanceEnabled,payrollEnabled,
   attendance:{clock,businessDate,dayKind,leavePresence:presence.get(subjectId)?.get(businessDate)??null,workLocations}};
 },{readOnlySnapshot:true});
 const paymentDate=payrollEnabled?await readOwnNextPayrollPaymentDate(ctx,subjectId):null;
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
