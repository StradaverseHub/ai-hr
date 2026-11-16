/** Exact, transaction-local authority minted by the Contract posting owner, never by roles or a form. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
export type ContractPostingIntent={postingId:string;employmentId:string;kind:'contractRenewal'|'contractConversion';effectiveDate:string;endDate:string|null;contractNumber:string|null;remarks:string;completed:boolean;groupId:string|null};
const active=new WeakMap<object,Readonly<ContractPostingIntent>>();
export async function withContractPostingIntentTx<T>(tx:Tx,postingId:string,run:(intent:Readonly<ContractPostingIntent>)=>Promise<T>):Promise<T>{
 const[row]=await tx.execute<{intent:ContractPostingIntent}>(sql`select app.contract_shared_posting_intent(${postingId}::uuid) as intent`);
 if(!row?.intent)throw Error('Approved Contract posting intent unavailable.');
 if(active.has(tx))throw Error('A Contract posting intent is already active.');
 const intent=Object.freeze(row.intent);active.set(tx,intent);try{return await run(intent);}finally{active.delete(tx);}
}
export function contractPostingMovementAuthorityTx(tx:Tx|undefined,input:Record<string,unknown>):boolean{
 const i=tx&&active.get(tx);if(!i||i.completed||input.employmentId!==i.employmentId||input.kind!==i.kind||input.effectiveDate!==i.effectiveDate||input.contractPostingId!==i.postingId)return false;
 return Object.keys(input).every(k=>input[k]===undefined||['employmentId','kind','effectiveDate','endDate','contractPostingId','contractStartDate','contractNumber','remarks','typeCode'].includes(k))&&(input.endDate??null)===i.endDate&&input.contractStartDate===(i.kind==='contractRenewal'?i.effectiveDate:null)&&(input.contractNumber??null)===i.contractNumber&&input.remarks===i.remarks&&(input.typeCode===undefined||input.typeCode===i.kind);
}
export function contractPostingInfoAuthorityTx(tx:Tx|undefined,input:Record<string,unknown>):boolean{
 const i=tx&&active.get(tx);if(!i||i.completed||input.employmentId!==i.employmentId)return false;
 if(Object.keys(input).some(k=>!['employmentId','contractStartDate','contractEndDate','contractNumber','movement'].includes(k)))return false;
 const movement=input.movement as {type?:string;effectiveDate?:string}|undefined;
 return movement?.type===i.kind&&movement.effectiveDate===i.effectiveDate&&input.contractStartDate===(i.kind==='contractRenewal'?i.effectiveDate:null)&&input.contractEndDate===i.endDate&&(input.contractNumber===undefined||String(input.contractNumber)===i.contractNumber);
}
export function contractPostingAssignmentAuthorityTx(tx:Tx|undefined,input:Record<string,unknown>):boolean{
 const i=tx&&active.get(tx);if(!i||i.completed||i.kind!=='contractConversion'||input.employmentId!==i.employmentId||input.employmentType!=='full_time'||input.effectiveDate!==i.effectiveDate)return false;
 return Object.keys(input).every(k=>input[k]===undefined||['employmentId','effectiveDate','employmentType','movement'].includes(k));
}
export function currentContractPostingIntentTx(tx:Tx):Readonly<ContractPostingIntent>|undefined{return active.get(tx);}
