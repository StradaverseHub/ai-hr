/** A minimal own Time Off projection over the existing leave dashboard and approved-date owners.
 * Available is already net of pending reservations; Home must never subtract Pending again. */
import {settleReadGroup} from '../lib/settle-read-group';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {hasEligibleLeaveTypeFrom} from './read';
import {requireActiveOwnHomeSnapshotEmploymentIdTx} from './employee-home';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {readOwnLeaveInputsTx} from './own-leave-inputs';
import {myCurrentLeaveSnapshotCards} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
export async function readEmployeeHomeTimeOff(ctx:SessionContext,employmentId?:string,locale?:string,signal?:AbortSignal):Promise<EmployeeHomeTimeOff>{
 return withTenant(ctx,async tx=>{
  const subjectId=await requireActiveOwnHomeSnapshotEmploymentIdTx(tx,ctx,employmentId);
  signal?.throwIfAborted();
  const today=todayInKualaLumpur();
  // The cards' own principal proof is asked before any leave figure is read. The cards, the next approved date and
  // the Apply entry point are then answered from one bundled read of this employment's leave inputs
  // (core/own-leave-inputs.ts) by the same calculators; the proof inside the cards is the same statement again.
  await assertAiPresentationPrincipalTx(tx,ctx);
  const inputs=await readOwnLeaveInputsTx(tx,subjectId,today);
  signal?.throwIfAborted();
  const [cards,eligible]=await settleReadGroup([
   ()=>myCurrentLeaveSnapshotCards(ctx,subjectId,{today,locale},tx,inputs),
   ()=>hasEligibleLeaveTypeFrom(tx,subjectId,inputs),
  ]);
  if(cards.length>100)throw Error('Own leave catalogue exceeds its supported Home limit.');
  return {version:1,employmentId:subjectId,asOf:today,canApply:eligible,
   balances:cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})),
   nextApproved:inputs.nextApproved};
 },{readOnlySnapshot:true,readSignal:signal});
}
