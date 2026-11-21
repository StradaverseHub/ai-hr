/** Employment-history maintenance protects issued payroll independently of an HR acknowledgement. */
import {lockEmploymentStatutoryOwnerTx} from './employment-statutory-owner-lock';
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { assertWorkforceEmploymentTx } from './workforce-access';
import { lockPayrollInputsTx } from './payroll-inputs-lock';
import { payrollPreservationRefusal, withClosedPayrollCorrectionAuthorityTx } from './closed-payroll-correction-authority';
import {assertContractPostingHistoryWriteTx,hasContractPostingHistorySourceTx,protectContractPostingHistoryTx} from './contract-posting-history-source';

// A savepoint has its own Tx object. A rolled-back rehearsal must never mark its parent as preserved.
const preserved = new WeakMap<object, Map<string, number>>();
export async function preserveMovementPayrollTx(tx: Tx, employmentId: string, refusal: (message: string) => Error): Promise<number> {
  const prior = preserved.get(tx)?.get(employmentId);
  if (prior !== undefined) return prior;
  await lockPayrollInputsTx(tx, { employmentIds: [employmentId] });
  await lockEmploymentStatutoryOwnerTx(tx,employmentId);
  let count: number;
  try {
    const [row] = await tx.execute<{ count: number }>(sql`select app.preserve_movement_payroll(${employmentId}::uuid) as count`);
    if (!row) throw new Error('Historical payroll metadata could not be protected.');
    count = Number(row.count);
  } catch (error) {
    const message = payrollPreservationRefusal(error);
    if (message) throw refusal(message);
    throw error;
  }
  const subjects = preserved.get(tx) ?? new Map<string, number>();
  subjects.set(employmentId, count);
  preserved.set(tx, subjects);
  return count;
}

/** Private owner scope: fresh maintenance rights, serialized payroll inputs and retained documents first. */
export async function withProtectedMovementHistoryTx<T>(tx: Tx, ctx: SessionContext, employmentId: string,
  write: () => Promise<T>, refusal: (message: string) => Error): Promise<T> {
  await assertWorkforceEmploymentTx(tx, ctx, employmentId, 'maintain');
  return withPreservedMovementHistoryTx(tx,employmentId,()=>preserveMovementPayrollTx(tx,employmentId,refusal),write);
}

/** One canonical preservation/correction sequence; public maintenance retains its original admission. */
async function withPreservedMovementHistoryTx<T>(tx:Tx,employmentId:string,preserve:()=>Promise<unknown>,write:()=>Promise<T>){
 await preserve();
 return withClosedPayrollCorrectionAuthorityTx(tx,employmentId,write);
}

/** Fixed privileged Contract owner, entered before any inverse. Native preservation returns no data here. */
export function withContractPostingProtectedHistoryTx<T>(tx:Tx,employmentId:string,write:()=>Promise<T>):Promise<T>{
 if(!hasContractPostingHistorySourceTx(tx,employmentId))throw Error('The actual Contract application source is required.');
 return withPreservedMovementHistoryTx(tx,employmentId,async()=>{
  const count=await protectContractPostingHistoryTx(tx);
  const subjects=preserved.get(tx)??new Map<string,number>();subjects.set(employmentId,count);preserved.set(tx,subjects);
 },write);
}

/** An already-protected recorded step or target; source proof is independent of a caller role. */
export async function withContractPostingProtectedStepTx<T>(tx:Tx,employmentId:string,write:()=>Promise<T>):Promise<T>{
 await assertContractPostingHistoryWriteTx(tx,employmentId);
 return withClosedPayrollCorrectionAuthorityTx(tx,employmentId,write);
}
