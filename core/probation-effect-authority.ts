import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
type Intent={employmentId:string;kind:'confirmation'|'probationExtension';effectiveDate:string;endDate:string|null;outcomeId:string;sourceKey:string;completed:boolean};
const active=new WeakMap<object,Intent>();
/** The native source owner rechecks released content and current actor under its row lock. */
export async function withProbationPersonnelIntentTx<T>(tx:Tx,outcomeId:string,run:(intent:Intent)=>Promise<T>):Promise<T>{
 const[row]=await tx.execute<{intent:Intent}>(sql`select app.probation_personnel_intent(${outcomeId}::uuid) as intent`);if(!row?.intent)throw Error('Released probation Personnel intent unavailable.');
 const prior=active.get(tx);active.set(tx,row.intent);try{return await run(row.intent);}finally{if(prior)active.set(tx,prior);else active.delete(tx);}
}
export function probationMovementAuthorityTx(tx:Tx|undefined,input:{employmentId:string;kind:string;effectiveDate:string;endDate?:string|null}){const i=tx&&active.get(tx);return !!i&&!i.completed&&i.employmentId===input.employmentId&&i.kind===input.kind&&i.effectiveDate===input.effectiveDate&&(i.endDate??null)===(input.endDate??null);}
export function probationDateAuthorityTx(tx:Tx|undefined,input:Record<string,unknown>){const i=tx&&active.get(tx);if(!i||i.completed||i.employmentId!==input.employmentId)return false;const allowed=['employmentId','movement',i.kind==='confirmation'?'confirmationDate':'extendedConfirmationDate'];if(Object.keys(input).some(k=>!allowed.includes(k)))return false;const movement=input.movement as {type?:string;effectiveDate?:string;endDate?:string}|undefined;return !!movement&&movement.type===i.kind&&(i.kind==='confirmation'?input.confirmationDate===i.effectiveDate:input.extendedConfirmationDate===i.endDate&&movement.effectiveDate===i.effectiveDate);}
