import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assertWorkforceEmploymentTx} from './workforce-access';

/** A limited invalidation owner: returns a count, reads no amounts and cannot process or close payroll.
 * The native writer acquires payroll input keys BEFORE rows; SQL verifies those holds independently. */
export async function markWorkforcePayrollInputsChangedTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;from:string;until?:string|null}){
 await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
 const [row]=await tx.execute<{count:number}>(sql`select app.workforce_payroll_inputs_changed(${p.employmentId}::uuid,${p.from}::date,${p.until??null}::date,'employment_information') as count`);
 return Number(row?.count??0);
}
