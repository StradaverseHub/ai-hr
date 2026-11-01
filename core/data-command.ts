/** Audited database-only ordinary commands: shared authority, unchanged business/RLS owners. */
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {beginDataCommandAuthorityTx,DataCommandRequiresExclusive,lockAccessConfigurationTx} from './access-configuration-lock';
import {isCarrierPrincipalCurrentTx} from './carrier-principal';
type TransactionOwner=<T>(ctx:SessionContext,run:(tx:Tx)=>Promise<T>)=>Promise<T>;
/** Only a precise configuration-demand sentinel retries, ONCE and after the entire first transaction
 * rolled back. Busy locks, deadlocks, validation failures and SQL errors are never retried here.
 * Callers must be database-only: events and bytea attachments roll back; external effects cannot join.
 * Existing transactions are deliberately handled by their original caller, without partial retries. */
export async function withDataCommand<T>(supplied:SessionContext,run:(tx:Tx)=>Promise<T>,owner:TransactionOwner=withTenant):Promise<T>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 // SYSTEM and agent commands retain their own stronger, original ownership contracts.
 if(!ctx.userId||ctx.agent)return owner(ctx,run);
 try{
  return await owner(ctx,async tx=>{
   await beginDataCommandAuthorityTx(tx,ctx.tenantId);
   if(!(await isCarrierPrincipalCurrentTx(tx,ctx)))throw new Error('Current command principal required.');
   return run(tx);
  });
 }catch(error){
  if(!(error instanceof DataCommandRequiresExclusive))throw error;
  return owner(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);return run(tx);});
 }
}
