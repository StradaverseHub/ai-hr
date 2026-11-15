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

/** 646355e5 — closed payroll lies in the corrected period; HR must confirm it stays as issued. Lives here (not in
 *  movement.ts) so the date writers in core/org.ts can raise it too (board 4604dccc r3). */
export class MovementClosedPayrollAcknowledgementError extends Error {
  constructor(readonly periods: string[]) {
    super(
      `Payroll for ${periods.join(', ')} is already closed. Confirm that the closed payroll, released payslips and statutory submissions will not change, then save the correction again.`,
    );
    this.name = 'MovementClosedPayrollAcknowledgementError';
  }
}

/** Board 4604dccc r3 — the two data refusals left in app.preserve_information_payroll, in the screen's words. */
export function payrollPreservationRefusal(error:unknown):string|null{
 const texts:string[]=[];for(let e:unknown=error;e instanceof Error&&texts.length<5;e=(e as {cause?:unknown}).cause)texts.push(e.message);
 const all=texts.join(' ');
 if(all.includes('Historical payroll company permission is required'))return 'You do not have access to a company that paid this employee\'s earlier payroll. Ask an administrator of that company to make this correction.';
 if(all.includes('Historical assignment evidence requires reconciliation'))return 'The employee\'s current company and position record needs review in Employment Movement before it can be corrected.';
 return null;
}
