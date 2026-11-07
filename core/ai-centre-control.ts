import {lockAccessConfigurationTx} from './access-configuration-lock';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
import {aiCentreActivity,runAiCentreActivity} from '../lib/ai/centre-activity';

/** The SQL owner serialises this check with stop writes; hold tx through a native effect. */
export async function assertAiCentreRunningTx(tx:Tx,ctx:Pick<SessionContext,'tenantId'>,expected?:number):Promise<number>{
 try{
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{generation:number}>(sql`select app.ai_centre_assert_running(${expected??aiCentreActivity(ctx.tenantId)?.generation??null}::integer) as generation`);
  if(row?.generation===null)throw new AiAllowanceError('paused');
  if(!Number.isSafeInteger(row?.generation)||row.generation<0)throw new AiGatewayError('AI controls could not be confirmed.');
  return row.generation;
 }catch(error){
  if((error as {code?:string})?.code==='55000'||(error as {cause?:{code?:string}})?.cause?.code==='55000')throw new AiAllowanceError('paused');
  throw error;
 }
}

export async function withAiCentreActivity<T>(ctx:SessionContext,work:()=>Promise<T>):Promise<T>{
 const generation=await withTenant(ctx,tx=>assertAiCentreRunningTx(tx,ctx));
 if(aiCentreActivity(ctx.tenantId))return work();
 return runAiCentreActivity(ctx.tenantId,generation,work);
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
