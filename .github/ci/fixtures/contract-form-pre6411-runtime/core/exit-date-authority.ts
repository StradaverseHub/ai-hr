/** Transaction-bound internal authority. A posted movement tag alone is never a date grant. */
import type { Tx } from '../db/client';
const owners=new WeakMap<object,Map<string,number>>();
export function hasExitDateAuthorityTx(tx:Tx|undefined,employmentId:string) {
  return !!tx && (owners.get(tx)?.get(employmentId)??0)>0;
}
/** Only canonical Movement's apply/reverse owner enters this scope. */
export async function withExitDateAuthorityTx<T>(tx:Tx,employmentId:string,write:()=>Promise<T>):Promise<T> {
  const subjects=owners.get(tx)??new Map<string,number>();owners.set(tx,subjects);
  subjects.set(employmentId,(subjects.get(employmentId)??0)+1);
  try{return await write();}finally{const n=(subjects.get(employmentId)??1)-1;if(n)subjects.set(employmentId,n);else subjects.delete(employmentId);if(!subjects.size)owners.delete(tx);}
}
