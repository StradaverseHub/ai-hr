/** Fixed request-bound calculation seam. Only the native decision owners call this helper; the caller's
 * actor remains the delegate in every event. The owning SQL validates the pending request and live line.
 * No switched identity escapes the savepoint, including SQL failures. */
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';

type Identity={userId:string;roles:string;grants:string};
async function identity(tx:Tx):Promise<Identity>{
 const [row]=await tx.execute<Identity>(sql`select coalesce(current_setting('app.user_id',true),'') as "userId",coalesce(current_setting('app.roles',true),'') as roles,coalesce(current_setting('app.grants',true),'') as grants`);
 if(!row)throw Error('Delegated calculation identity unavailable');return row;
}
export async function withDelegatedRequestEffectTx<T>(tx:Tx,ctx:SessionContext,request:{id:string;kind:'replacement_leave'|'attendance';employmentId:string},work:(effectTx:Tx)=>Promise<T>):Promise<T>{
 const [visible]=await tx.execute<{ok:boolean}>(sql`select app.can_see_employment(${request.employmentId}::uuid) as ok`);
 if(visible?.ok===true)return work(tx);
 const [effect]=await tx.execute<{user_id:string;roles:string;grants:unknown}>(sql`select * from app.delegated_request_effect_identity(${request.id}::uuid,${request.kind})`);
 if(!ctx.userId||!effect)throw Error('The delegated request no longer has a live calculation identity.');
 const before=await identity(tx);
 if(before.userId!==ctx.userId)throw Error('Delegated calculation caller changed');
 // Postgres.js leaves nested savepoints active after success. Own an explicit outer boundary so
 // releasing it also closes the driver's child savepoint BEFORE native final audit/provenance writes.
 await tx.execute(sql`SAVEPOINT delegated_request_effect_boundary`);
 let result:T;
 try{
  result=await tx.transaction(async inner=>{
   const effectTx=inner as unknown as Tx;
   await inner.execute(sql`select set_config('app.user_id',${effect.user_id},true),set_config('app.roles',${effect.roles},true),set_config('app.grants',${JSON.stringify(effect.grants)},true)`);
   const value=await work(effectTx);
   await inner.execute(sql`select set_config('app.user_id',${before.userId},true),set_config('app.roles',${before.roles},true),set_config('app.grants',${before.grants},true)`);
   if(!isDeepStrictEqual(await identity(effectTx),before))throw Error('Delegated calculation identity was not restored');
   return value;
  });
  await tx.execute(sql`RELEASE SAVEPOINT delegated_request_effect_boundary`);
 }catch(error){
  await tx.execute(sql`ROLLBACK TO SAVEPOINT delegated_request_effect_boundary`);
  await tx.execute(sql`RELEASE SAVEPOINT delegated_request_effect_boundary`);
  if(!isDeepStrictEqual(await identity(tx),before))throw Error('Delegated calculation identity was not restored after failure',{cause:error});
  throw error;
 }
 if(!isDeepStrictEqual(await identity(tx),before))throw Error('Delegated calculation identity was not restored');
 return result;
}
