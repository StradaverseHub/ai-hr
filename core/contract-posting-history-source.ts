/** Fixed Contract application owner. No request context, role or caller flag supplies this scope. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

type Source={jobId:string;employmentId:string};
const sources=new WeakMap<object,Readonly<Source>>();

/** Called only by the fixed posting worker after its native begin validated the actual human admission. */
export async function withContractPostingHistorySourceTx<T>(tx:Tx,source:Source,write:()=>Promise<T>):Promise<T>{
 if(sources.has(tx))throw Error('A Contract posting source is already active.');
 const[held]=await tx.execute<{held:boolean}>(sql`select app.contract_posting_job_tx_held(${source.jobId}::uuid,${source.employmentId}::uuid) as held`);
 if(held?.held!==true)throw Error('The actual Contract posting application owner is unavailable.');
 sources.set(tx,Object.freeze({...source}));
 try{return await write();}finally{sources.delete(tx);}
}

export function hasContractPostingHistorySourceTx(tx:Tx,employmentId:string){return sources.get(tx)?.employmentId===employmentId;}
/** A genuine native savepoint shares its parent's already-proven job/backend/XID, never caller roles. */
export function withContractPostingSavepointSourceTx<T>(parent:Tx,child:Tx,write:()=>Promise<T>):Promise<T>{
 const source=sources.get(parent);
 return source?withContractPostingHistorySourceTx(child,source,write):write();
}
export function contractPostingHistoryJobTx(tx:Tx,employmentId:string):string{
 const source=sources.get(tx);if(!source||source.employmentId!==employmentId)throw Error('The actual Contract application source is required.');
 return source.jobId;
}

/** Native private step/target frame independently proves backend, transaction, subject and recorded source. */
export async function assertContractPostingHistoryWriteTx(tx:Tx,employmentId:string):Promise<void>{
 const source=sources.get(tx);
 if(!source||source.employmentId!==employmentId)throw Error('A fixed Contract history source is required.');
 const[held]=await tx.execute<{held:boolean}>(sql`select app.contract_posting_history_write_held(${source.jobId}::uuid,${employmentId}::uuid) as held`);
 if(held?.held!==true)throw Error('The recorded Contract history step changed.');
}

export async function withContractPostingRecordedStepTx<T>(tx:Tx,eventId:string,direction:'inverse'|'replay',write:()=>Promise<T>):Promise<T>{
 const source=sources.get(tx);if(!source)throw Error('A fixed Contract history source is required.');
 await tx.execute(sql`select app.contract_posting_replay_step_begin(${source.jobId}::uuid,${eventId}::uuid,${direction})`);
 const result=await write();
 await tx.execute(sql`select app.contract_posting_replay_step_end(${source.jobId}::uuid,${eventId}::uuid,${direction})`);
 return result;
}

export async function registerContractPostingReplayPlanTx(tx:Tx,steps:readonly {eventId:string;direction:'inverse'|'replay'}[]):Promise<void>{
 const source=sources.get(tx);if(!source)throw Error('A fixed Contract history source is required.');
 await tx.execute(sql`select app.contract_posting_replay_plan(${source.jobId}::uuid,${JSON.stringify(steps)}::jsonb)`);
}

export async function withContractPostingTargetTx<T>(tx:Tx,write:()=>Promise<T>):Promise<T>{
 const source=sources.get(tx);if(!source)throw Error('A fixed Contract history source is required.');
 await tx.execute(sql`select app.contract_posting_replay_target_begin(${source.jobId}::uuid)`);
 const result=await write();
 await tx.execute(sql`select app.contract_posting_replay_target_end(${source.jobId}::uuid)`);
 return result;
}

/** Seal the actual as-of image after the canonical correction-boundary lift, before minting its intent. */
export async function prepareContractPostingTargetTx(tx:Tx):Promise<void>{
 const source=sources.get(tx);if(!source)throw Error('A fixed Contract history source is required.');
 await tx.execute(sql`select app.contract_posting_replay_target_prepare(${source.jobId}::uuid)`);
}

export async function protectContractPostingHistoryTx(tx:Tx):Promise<number>{
 const source=sources.get(tx);if(!source)throw Error('A fixed Contract history source is required.');
 const[row]=await tx.execute<{count:number}>(sql`select app.contract_posting_job_protect(${source.jobId}::uuid,${source.employmentId}::uuid) as count`);
 if(!row)throw Error('Issued Payroll metadata protection is unavailable.');
 return Number(row.count);
}

export async function bindContractPostingHistoryIntentTx(tx:Tx):Promise<void>{
 const source=sources.get(tx);if(!source)throw Error('A fixed Contract history source is required.');
 await tx.execute(sql`select app.contract_posting_job_bind_intent(${source.jobId}::uuid,${source.employmentId}::uuid)`);
}
