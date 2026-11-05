/** A minimal own Time Off projection over the existing leave dashboard and approved-date owners.
 * Available is already net of pending reservations; Home must never subtract Pending again. */
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {hasEligibleLeaveTypeForTx} from './read';
import {requireActiveOwnHomeEmploymentIdTx} from './employee-home';
import {myCurrentLeaveCards,nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export async function readEmployeeHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string):Promise<EmployeeHomeTimeOff>{
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);
  const subjectId=await requireActiveOwnHomeEmploymentIdTx(tx,ctx,employmentId);
  const today=todayInKualaLumpur();
  const [cards,nextApproved,eligible]=await Promise.all([
   myCurrentLeaveCards(ctx,subjectId,{today,locale},tx),
   nextApprovedLeavePresenceTx(tx,subjectId,today),
   hasEligibleLeaveTypeForTx(tx,subjectId),
  ]);
  if(cards.length>100)throw Error('Own leave catalogue exceeds its supported Home limit.');
  return {version:1,employmentId:subjectId,asOf:today,canApply:eligible,
   balances:cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})),
   nextApproved};
 });
}
