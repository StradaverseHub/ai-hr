/** 646355e5 — transaction-bound authority for an acknowledged Movement correction behind closed payroll.
 *  Same shape as exit-date-authority: a posted flag alone is never a grant; only Movement's correction
 *  owner enters this scope, after the acknowledgement, reason and payslip snapshot are in place. */
import type { Tx } from '../db/client';
const owners=new WeakMap<object,Map<string,number>>();
export function hasClosedPayrollCorrectionAuthorityTx(tx:Tx|undefined,employmentId:string) {
  return !!tx && (owners.get(tx)?.get(employmentId)??0)>0;
}
/** Only canonical Movement's correction owner enters this scope. */
export async function withClosedPayrollCorrectionAuthorityTx<T>(tx:Tx,employmentId:string,write:()=>Promise<T>):Promise<T> {
  const subjects=owners.get(tx)??new Map<string,number>();owners.set(tx,subjects);
  subjects.set(employmentId,(subjects.get(employmentId)??0)+1);
  try{return await write();}finally{const n=(subjects.get(employmentId)??1)-1;if(n)subjects.set(employmentId,n);else subjects.delete(employmentId);if(!subjects.size)owners.delete(tx);}
}
