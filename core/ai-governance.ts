import { sql } from 'drizzle-orm';
import { withTenant,type SessionContext } from '../db/client';
import { AiGatewayError,type AiUsage,type ResolvedAiConfig } from '../lib/ai/types';
import { isAiFeature,type AiFeatureId } from '../lib/ai/features';

/** The resolved configuration carries the calling authorization as an opaque, server-only capability. */
export function governedAiConfig(ctx:SessionContext,cfg:ResolvedAiConfig,feature:AiFeatureId):ResolvedAiConfig{
 if(!isAiFeature(feature))throw new AiGatewayError('Unknown AI feature.');
 return {...cfg,governance:{async run(request,call){
  const [admission]=await withTenant(ctx,tx=>tx.execute<{run_id:string;allowed:boolean;blocked_reason:string|null}>(sql`select * from app.ai_admit(${feature},${request.operation},${cfg.provider},${cfg.model},${request.reservedTokens}::bigint)`));
  if(!admission?.allowed)throw new AiGatewayError(admission?.blocked_reason==='paused'?'This AI feature is paused.':admission?.blocked_reason==='daily_limit'?'The daily AI request allowance has been reached.':'The monthly AI token allowance has insufficient available capacity.');
  let actual:number|null=null;
  const record=(usage:AiUsage)=>{const values=[usage.inputTokens,usage.outputTokens,usage.cachedInputTokens];if(values.every(n=>Number.isSafeInteger(n)&&n>=0)&&values.some(n=>n>0))actual=values.reduce((a,b)=>a+b,0);};
  let succeeded=false;
  try{const result=await call(record);succeeded=true;return result;}
  finally{
   // A failed write is visible and leaves the reservation held; it must never erase unconfirmed usage.
   try { await withTenant(ctx,tx=>tx.execute(sql`select app.ai_settle(${admission.run_id}::uuid,${succeeded},${actual}::bigint)`)); }
   catch { throw new AiGatewayError('AI usage could not be confirmed. Its reservation remains held.'); }
  }
 }}};
}
