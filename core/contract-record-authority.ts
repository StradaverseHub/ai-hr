/** Transaction-local proof minted only by the native, actual-owner accepted-intent reader.
 * No role is fabricated; exact command values come from the immutable accepted revision. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
export type ContractRecordIntent={caseId:string;employmentId:string;startOn:string;endOn:string;salaryChanged:boolean;allowanceChanged:boolean;salaryCents:string;allowanceCents:string;allowanceComponentId:string;fixedAllowanceId:string|null;fixedProrate:boolean|null;fixedCycle:string|null;fixedRunType:'regular'|'off_cycle'|'bonus'|'adjustment'|null;reason:string;done?:boolean;receipt?:Record<string,unknown>};
const intents=new WeakMap<object,ContractRecordIntent>();
export async function withAcceptedContractRecordIntentTx<T>(tx:Tx,caseId:string,run:(intent:ContractRecordIntent)=>Promise<T>):Promise<T>{
 if(intents.has(tx))throw Error('A contract record intent is already active.');
 const [row]=await tx.execute<{intent:ContractRecordIntent}>(sql`select app.contract_prepare_records(${caseId}::uuid) as intent`);
 if(!row?.intent)throw Error('Accepted contract record intent unavailable.');
 const intent=Object.freeze(row.intent);intents.set(tx,intent);try{return await run(intent);}finally{intents.delete(tx);}
}
export function contractCompensationAuthorityTx(tx:Tx|undefined,p:Record<string,unknown>):boolean{
 const i=tx?intents.get(tx):undefined;return !!i&&i.salaryChanged&&Object.keys(p).every(k=>['employmentId','basicSalary','effectiveFrom','remarks'].includes(k))&&p.employmentId===i.employmentId&&p.effectiveFrom===i.startOn&&p.basicSalary===Number(i.salaryCents)/100&&p.remarks===i.reason;
}
export function contractDateAuthorityTx(tx:Tx|undefined,p:{employmentId:string;contractStartDate?:string|null;contractEndDate?:string|null}):boolean{
 const i=tx?intents.get(tx):undefined;return !!i&&Object.keys(p).length===3&&p.employmentId===i.employmentId&&p.contractStartDate===i.startOn&&p.contractEndDate===i.endOn;
}
