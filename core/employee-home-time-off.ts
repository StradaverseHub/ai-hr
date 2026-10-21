/** A minimal own Time Off projection over the existing leave dashboard and approved-date owners.
 * Available is already net of pending reservations; Home must never subtract Pending again. */
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {myOwnEmploymentSubjects} from './read';
import {requireOwnHomeSubject,HomeAccessError} from './employee-home';
import {myLeaveDashboard,nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';

export type EmployeeHomeTimeOff={
 version:1;employmentId:string;asOf:string;
 balances:{id:string;name:string;annualLeave:boolean;available:number|null;pending:number|null}[];
 nextApproved:{requestId:string;date:string;duration:'full_day'|'part_day'}|null;
};
export async function readEmployeeHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string):Promise<EmployeeHomeTimeOff>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 // A prior selected card cannot survive a blocked/archived login or a now-ended employment.
 const active=await myOwnEmploymentSubjects(ctx,{profileEdit:true});
 if(!active.some(row=>row.employmentId===subject.employmentId))throw new HomeAccessError('employmentUnavailable');
 const today=todayInKualaLumpur();
 const [dashboard,nextApproved]=await Promise.all([
  myLeaveDashboard(ctx,subject.employmentId,{today,locale}),
  withTenant(ctx,tx=>nextApprovedLeavePresenceTx(tx,subject.employmentId,today)),
 ]);
 if(dashboard.cards.length>100)throw Error('Own leave catalogue exceeds its supported Home limit.');
 return {version:1,employmentId:subject.employmentId,asOf:today,
  balances:dashboard.cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})),
  nextApproved};
}
