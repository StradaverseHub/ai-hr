/** A minimal own Time Off projection over the existing leave dashboard and approved-date owners.
 * Available is already net of pending reservations; Home must never subtract Pending again. */
import {settleReadGroup} from '../lib/settle-read-group';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {hasEligibleLeaveTypeForTx} from './read';
import {requireActiveOwnHomeSnapshotEmploymentIdTx} from './employee-home';
import {myCurrentLeaveSnapshotCards,nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export async function readEmployeeHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string,signal?:AbortSignal):Promise<EmployeeHomeTimeOff>{
 return withTenant(ctx,async tx=>{
  const subjectId=await requireActiveOwnHomeSnapshotEmploymentIdTx(tx,ctx,employmentId);
  signal?.throwIfAborted();
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
 },{readOnlySnapshot:true,readSignal:signal});
}
