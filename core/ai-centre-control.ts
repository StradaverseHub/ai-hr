import {accessLockModeHeldTx,lockAccessConfigurationTx,lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
import {aiCentreActivity,runAiCentreActivity,trackAiCentreFunctions} from '../lib/ai/centre-activity';

/**
 * Access mode for an AI control check (reader/writer Access lock, wave 4). The check itself only needs the
 * stop switch and function controls to stay stable: their writers hold Access exclusively, and the SQL
 * owner also serialises every check on the tenant ai-control lock. A transaction that already holds
 * Access shared is a converted writer, so it joins shared and never upgrades (two upgrading writers
 * would deadlock). One that holds nothing still takes it exclusively, because a caller's own later
 * effect may rely on that until the caller itself is verified. An exclusive holder simply re-enters.
 */
export async function lockAccessForAiControlCheckTx(tx:Tx,tenantId:string):Promise<void>{
  if(await accessLockModeHeldTx(tx,tenantId)==='S')await lockAccessConfigurationTx(tx,tenantId);
  else await lockAccessConfigurationWriteTx(tx,tenantId);
}

/** The SQL owner serialises this check with stop writes; hold tx through a native effect. */
export async function assertAiCentreRunningTx(tx:Tx,ctx:Pick<SessionContext,'tenantId'>,expected?:number,additionalFunctions:readonly string[]=[]):Promise<number>{
  await lockAccessForAiControlCheckTx(tx,ctx.tenantId);
  return assertAiCentreRunningLockedTx(tx,ctx,expected,additionalFunctions);
}

/** For a transaction that does nothing but this check (before or after a provider call): a read of the
 * controls, so it holds Access shared and never stops clock-ins. Stop writes still exclude it. */
export async function assertAiCentreRunningSharedTx(tx:Tx,ctx:Pick<SessionContext,'tenantId'>,expected?:number,additionalFunctions:readonly string[]=[]):Promise<number>{
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  return assertAiCentreRunningLockedTx(tx,ctx,expected,additionalFunctions);
}

async function assertAiCentreRunningLockedTx(tx:Tx,ctx:Pick<SessionContext,'tenantId'>,expected:number|undefined,additionalFunctions:readonly string[]):Promise<number>{
  const [row]=await tx.execute<{generation:number}>(sql`select app.ai_centre_assert_running(${expected??aiCentreActivity(ctx.tenantId)?.generation??null}::integer) as generation`);
  if(row?.generation===null)throw new AiAllowanceError('paused');
  if(!Number.isSafeInteger(row?.generation)||row.generation<0)throw new AiGatewayError('AI controls could not be confirmed.');
  for(const key of new Set([...(aiCentreActivity(ctx.tenantId)?.functions??[]),...additionalFunctions])){
   const [functionState]=await tx.execute<{allowed:boolean}>(sql`select app.ai_centre_read_allowed(${key}) as allowed`);
   if(functionState?.allowed!==true)throw new AiAllowanceError('paused');
  }
  return row.generation;
}

export async function withAiCentreActivity<T>(ctx:SessionContext,work:()=>Promise<T>):Promise<T>{
 const generation=await withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx));
 if(aiCentreActivity(ctx.tenantId))return work();
 return runAiCentreActivity(ctx.tenantId,generation,async()=>{
  const result=await work();
  await withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx));
  return result;
 });
}

export type AiCentreControlState=Readonly<{stopped:boolean;generation:number;pending:number}>;
export async function aiCentreControlState(ctx:SessionContext):Promise<AiCentreControlState>{
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<AiCentreControlState>(sql`select * from app.ai_centre_control_state()`);
  if(!row||typeof row.stopped!=='boolean'||!Number.isSafeInteger(row.generation)||!Number.isSafeInteger(row.pending))throw new AiGatewayError('AI controls could not be confirmed.');
  return Object.freeze(row);
 });
}

/** These controls only narrow existing capability access; they never enable a module or worker. */
export async function aiCentreReadAllowed(ctx:SessionContext,name:string):Promise<boolean>{
 return withTenant(ctx,async tx=>{
  const key=name.includes(':')?name:'read:'+name;
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_centre_read_allowed(${key}) as allowed`);
  return row?.allowed===true;
 });
}

/** Successful child checks remain prerequisites for the complete root intent, including after
 * a nested helper returns. An unused refused child does not poison an enabled sibling. */
export async function withAiCentreFunction<T>(ctx:SessionContext,key:string|readonly string[],work:()=>Promise<T>):Promise<T>{
 const keys=typeof key==='string'?[key]:[...key];
 return withAiCentreActivity(ctx,async()=>{
  await withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx,undefined,keys));
  trackAiCentreFunctions(ctx.tenantId,keys);
  const result=await work();
  await withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx));
  return result;
 });
}
