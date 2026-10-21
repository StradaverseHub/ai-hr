/** A minimal own Time Off projection over the existing leave dashboard and approved-date owners.
 * Available is already net of pending reservations; Home must never subtract Pending again. */
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {myOwnEmploymentSubjects,listEligibleLeaveTypesFor} from './read';
import {requireOwnHomeSubject,HomeAccessError} from './employee-home';
import {myLeaveDashboard,nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export async function readEmployeeHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string):Promise<EmployeeHomeTimeOff>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 // A prior selected card cannot survive a blocked/archived login or a now-ended employment.
 const active=await myOwnEmploymentSubjects(ctx,{profileEdit:true});
 if(!active.some(row=>row.employmentId===subject.employmentId))throw new HomeAccessError('employmentUnavailable');
 const today=todayInKualaLumpur();
 const [dashboard,nextApproved,eligible]=await Promise.all([
  myLeaveDashboard(ctx,subject.employmentId,{today,locale}),
  withTenant(ctx,tx=>nextApprovedLeavePresenceTx(tx,subject.employmentId,today)),
  listEligibleLeaveTypesFor(ctx,subject.employmentId,locale),
 ]);
 if(dashboard.cards.length>100)throw Error('Own leave catalogue exceeds its supported Home limit.');
 return {version:1,employmentId:subject.employmentId,asOf:today,canApply:eligible.length>0,
  balances:dashboard.cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})),
  nextApproved};
}
