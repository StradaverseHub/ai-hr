import { sql } from 'drizzle-orm';
import { withTenant,type SessionContext,type Tx } from '../db/client';
import { AiGatewayError,AiAllowanceError,type AiUsage,type ResolvedAiConfig } from '../lib/ai/types';
import { AI_FEATURES,isAiFeature,type AiFeatureId } from '../lib/ai/features';

import { resolveEntitlementsTx, getSetting } from './entitlements';
import { assertAiPrincipalTx } from './ai-principal';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import type { AiAdmission } from '../lib/ai/governance';

/** Reuse the gateway's fresh setting/platform-kill resolution for deterministic action checks. */
async function forcedPauseTx(tx:Tx,ctx:SessionContext,feature:AiFeatureId):Promise<boolean>{
 const definition=AI_FEATURES.find(f=>f.id===feature)!;
 if(!definition.setting)return false;
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 return getSetting(fresh,definition.setting)!==true;
}

/**
 * SOURCE-ONLY until ai-action-controls.sql has a coordinated, journalled migration and passes its
 * app-role acceptance. Not wired to an endpoint. This is a pause prerequisite, NEVER action authority.
 * The caller owns fresh authentication/module/subject/consent checks and the exact transaction.
 * Keep that transaction open through the effect so policy writers cannot race its ai-control lock.
 * No model admission, reservation, quota reset, usage settlement or provider call occurs here.
 */
export async function assertAiActionUnpausedTx(tx:Tx,ctx:SessionContext,feature:AiFeatureId):Promise<void>{
 if(!isAiFeature(feature))throw new AiGatewayError('Unknown AI feature.');
 const forcedPause=await forcedPauseTx(tx,ctx,feature);
 const [control]=await tx.execute<{unpaused:boolean}>(sql`select app.ai_action_unpaused(${feature},${forcedPause}) as unpaused`);
 if(control?.unpaused===false)throw new AiAllowanceError('paused');
 if(control?.unpaused!==true)throw new AiGatewayError('AI action controls could not be confirmed.');
}

/** The resolved configuration carries the calling authorization as an opaque, server-only capability. */
export function governedAiConfig(ctx:SessionContext,cfg:ResolvedAiConfig,feature:AiFeatureId):ResolvedAiConfig{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 cfg={...cfg,...(cfg.provider==='openrouter'?{providerOptions:readOpenRouterOptions(cfg.providerOptions)}:{})};
 if(!isAiFeature(feature))throw new AiGatewayError('Unknown AI feature.');
 return Object.freeze({...cfg,governance:Object.freeze({async run<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void)=>Promise<T>):Promise<T>{
  const [admission]=await withTenant(ctx,async tx=>{
   await assertAiPrincipalTx(tx,ctx);
   const forcedPause=await forcedPauseTx(tx,ctx,feature);
   return tx.execute<{run_id:string;allowed:boolean;blocked_reason:string|null}>(sql`select * from app.ai_admit(${feature},${request.operation},${cfg.provider},${cfg.model},${request.reservedTokens}::bigint,${forcedPause})`);
  });
  if(!admission?.allowed){
   const reason=admission?.blocked_reason;
   if(reason==='paused'||reason==='daily_limit'||reason==='monthly_limit')throw new AiAllowanceError(reason);
   throw new AiGatewayError('The AI request could not be admitted.');
  }
  let actual:number|null=null;
  const record=(usage:AiUsage)=>{const values=[usage.inputTokens,usage.outputTokens,usage.cachedInputTokens];if(values.every(n=>Number.isSafeInteger(n)&&n>=0))actual=values.reduce((a,b)=>a+b,0);};
  let succeeded=false;
  try{const result=await call(record);succeeded=true;return result;}
  finally{
   // A failed write is visible and leaves the reservation held; it must never erase unconfirmed usage.
   try { await withTenant(ctx,tx=>tx.execute(sql`select app.ai_settle(${admission.run_id}::uuid,${succeeded},${actual}::bigint)`)); }
   catch { throw new AiGatewayError('AI usage could not be confirmed. Its reservation remains held.'); }
  }
 }})});
}
