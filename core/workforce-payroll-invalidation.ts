import type {MovementPayrollWindow} from '../lib/movement-payroll-windows';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assertWorkforceEmploymentTx} from './workforce-access';

/** A limited invalidation owner: returns a count, reads no amounts and cannot process or close payroll.
 * The native writer acquires payroll input keys BEFORE rows; SQL verifies those holds independently. */
export async function markWorkforcePayrollInputsChangedTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;from:string;until?:string|null}){
 if(movementPayrollInvalidationDeferredTx(tx,p.employmentId))return 0;
 await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
 const [row]=await tx.execute<{count:number}>(sql`select app.workforce_payroll_inputs_changed(${p.employmentId}::uuid,${p.from}::date,${p.until??null}::date,'employment_information') as count`);
 return Number(row?.count??0);
}

// Only the canonical Movement planner can defer intermediate inverse/replay invalidations. A nested
// writer cannot widen the final window and a failed savepoint cannot leak a deferral into its parent.
const deferred=new WeakMap<object,Set<string>>();
export function movementPayrollInvalidationDeferredTx(tx:Tx,employmentId:string){return deferred.get(tx)?.has(employmentId)??false;}
export async function withMovementPayrollWindowsTx<T>(tx:Tx,ctx:SessionContext,employmentId:string,windows:readonly MovementPayrollWindow[],work:()=>Promise<T>):Promise<T>{
 if(movementPayrollInvalidationDeferredTx(tx,employmentId))return work();
 const subjects=deferred.get(tx)??new Set<string>();deferred.set(tx,subjects);subjects.add(employmentId);
 let result:T;
 try{result=await work();}finally{subjects.delete(employmentId);if(!subjects.size)deferred.delete(tx);}
 if(windows.length){
  await assertWorkforceEmploymentTx(tx,ctx,employmentId,'maintain');
  await tx.execute(sql`select app.workforce_payroll_inputs_changed_windows(${employmentId}::uuid,${JSON.stringify(windows)}::jsonb,'employment_information')`);
 }
 return result;
}
