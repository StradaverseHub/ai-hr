/** A minimal own Time Off projection over the existing leave dashboard and approved-date owners.
 * Available is already net of pending reservations; Home must never subtract Pending again. */
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {isOwnProfileEditEmploymentTx,listEligibleLeaveTypesFor} from './read';
import {requireOwnHomeSubjectTx,HomeAccessError} from './employee-home';
import {myCurrentLeaveCards,nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export async function readEmployeeHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string):Promise<EmployeeHomeTimeOff>{
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);
  const subject=await requireOwnHomeSubjectTx(tx,ctx,employmentId);
  // A prior selected card cannot survive a blocked/archived login or a now-ended employment.
  if(!await isOwnProfileEditEmploymentTx(tx,ctx,subject.employmentId))throw new HomeAccessError('employmentUnavailable');
  const today=todayInKualaLumpur();
  const [cards,nextApproved,eligible]=await Promise.all([
   myCurrentLeaveCards(ctx,subject.employmentId,{today,locale},tx),
   nextApprovedLeavePresenceTx(tx,subject.employmentId,today),
   listEligibleLeaveTypesFor(ctx,subject.employmentId,locale,tx),
  ]);
  if(cards.length>100)throw Error('Own leave catalogue exceeds its supported Home limit.');
  return {version:1,employmentId:subject.employmentId,asOf:today,canApply:eligible.length>0,
   balances:cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})),
   nextApproved};
 });
}
