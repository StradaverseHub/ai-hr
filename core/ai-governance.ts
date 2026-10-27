import {createAiRunAccounting,type AiRunAccounting} from '../lib/ai/run-accounting';
import { sql } from 'drizzle-orm';
import { withTenant,type SessionContext,type Tx } from '../db/client';
import { AiGatewayError,AiAllowanceError,type AiUsage,type AiRunObservation,type ResolvedAiConfig } from '../lib/ai/types';
import { AI_FEATURES,isAiFeature,type AiFeatureId } from '../lib/ai/features';

import { resolveEntitlementsTx, getSetting } from './entitlements';
import { assertAiProviderSnapshot, assertAiProviderSnapshotFeature, assertCurrentAiProviderSnapshotTx, type AiProviderSnapshot } from './ai-provider-snapshot';
import type { AiAdmission } from '../lib/ai/governance';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {captureStrictAiSpendRoot,requiresStrictAiSpend,certifiedAiSpendEnvelope,type StrictAiSpendRoot} from '../lib/ai/spend-allocation';
export type {StrictAiSpendRoot} from '../lib/ai/spend-allocation';

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

/** Trusted command checks are additional refusal conditions, never model-supplied capabilities.
 * The exact current provider/principal is checked first; admission/settlement remain canonical.
 */
type AiAdmissionCheck = (tx: Tx, request: Readonly<AiAdmission>) => Promise<void>;
export type AiAdmissionLifecycle=Readonly<{
 admitted?:(tx:Tx,event:Readonly<{runId:string;request:Readonly<AiAdmission>}>)=>Promise<void>;
 settled?:(tx:Tx,event:Readonly<{runId:string;succeeded:boolean;actualTokens:number|null;accounting:AiRunAccounting}>)=>Promise<void>;
}>;
const issuedConfigurations = new WeakMap<object, { ctx: SessionContext; snapshot: AiProviderSnapshot; feature: AiFeatureId; check?: AiAdmissionCheck;lifecycle?:AiAdmissionLifecycle;spendRoot?:StrictAiSpendRoot }>();

/** Opaque server-only provider/principal binding, not HR disclosure or effect authorization. */
function createGovernedAiConfig(ctx:SessionContext,snapshot:AiProviderSnapshot,feature:AiFeatureId,check?:AiAdmissionCheck,lifecycle?:AiAdmissionLifecycle,spendRoot?:StrictAiSpendRoot):ResolvedAiConfig{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 assertAiProviderSnapshot(snapshot,ctx);
 assertAiProviderSnapshotFeature(snapshot,feature);
 const cfg=snapshot.configuration;
 if(!isAiFeature(feature))throw new AiGatewayError('Unknown AI feature.');
 const resolved=Object.freeze({...cfg,governance:Object.freeze({async run<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void,observe?:(observation:AiRunObservation)=>void)=>Promise<T>,outgoing:ResolvedAiConfig=cfg):Promise<T>{
  const capturedRequest=Object.freeze({operation:request.operation,reservedTokens:request.reservedTokens,
   ...(request.inputDigest===undefined?{}:{inputDigest:request.inputDigest})});
  if(!['draft','conversation','image'].includes(capturedRequest.operation)||!Number.isSafeInteger(capturedRequest.reservedTokens)||capturedRequest.reservedTokens<0||capturedRequest.reservedTokens>1000000000||
   (capturedRequest.inputDigest!==undefined&&!/^[a-f0-9]{64}$/.test(capturedRequest.inputDigest)))throw new AiGatewayError('The prepared AI request could not be confirmed.');
  const [admission]=await withTenant(ctx,async tx=>{
   await assertCurrentAiProviderSnapshotTx(tx,ctx,snapshot,outgoing);
   if(check)try{await check(tx,capturedRequest);}catch(error){
    if(error instanceof AiAllowanceError)throw error;
    throw new AiGatewayError('The current AI source access could not be confirmed.');
   }
   assertAiProviderSnapshot(snapshot,ctx);
   assertAiProviderSnapshotFeature(snapshot,feature);
   const strictSpend=requiresStrictAiSpend(feature)||spendRoot!==undefined;
   if(strictSpend&&!spendRoot)throw new AiGatewayError('The autonomous AI spend root could not be confirmed.');
   // Source-owned envelope only. Current unverified carriers REFUSE here, before token admission
   // and before any provider dispatch. A copied configuration or posted price cannot certify it.
   const envelope=strictSpend?certifiedAiSpendEnvelope(outgoing,capturedRequest):null;
   const forcedPause=await forcedPauseTx(tx,ctx,feature);
   const rows=await tx.execute<{run_id:string;allowed:boolean;blocked_reason:string|null}>(sql`select * from app.ai_admit(${feature},${capturedRequest.operation},${cfg.provider},${cfg.model},${capturedRequest.reservedTokens}::bigint,${forcedPause})`);
   if(rows[0]?.allowed&&envelope&&spendRoot)await tx.execute(sql`select app.ai_spend_reserve(${rows[0].run_id}::uuid,${spendRoot.rootTaskId}::uuid,${spendRoot.kind},${envelope.capabilityDigest},${envelope.requestDigest},${envelope.reservedNanos}::bigint)`);
   if(rows[0]?.allowed&&lifecycle?.admitted)await lifecycle.admitted(tx,Object.freeze({runId:rows[0].run_id,request:capturedRequest}));
   return rows;
  });
  if(!admission?.allowed){
   const reason=admission?.blocked_reason;
   if(reason==='paused'||reason==='daily_limit'||reason==='monthly_limit'||reason==='concurrent_limit')throw new AiAllowanceError(reason);
   throw new AiGatewayError('The AI request could not be admitted.');
  }
  let actual:number|null=null;
  const accounting=createAiRunAccounting(cfg.provider);
  const record=(usage:AiUsage)=>{const values=[usage.inputTokens,usage.outputTokens,usage.cachedInputTokens];if(values.every(n=>Number.isSafeInteger(n)&&n>=0))actual=values.reduce((a,b)=>a+b,0);};
  let succeeded=false;
  try{const result=await call(record,accounting.observe);succeeded=true;return result;}
  finally{
   // A failed write is visible and leaves the reservation held; it must never erase unconfirmed usage.
   try { const observed=accounting.snapshot(actual);await withTenant(ctx,async tx=>{
    // Same order as admission. This is ownership only: role revocation must not erase actual usage.
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    await tx.execute(sql`select app.ai_settle_observed(${admission.run_id}::uuid,${succeeded},${actual}::bigint,
    ${observed.providerObservationStatus},${observed.reportedInputTokens}::bigint,${observed.reportedOutputTokens}::bigint,${observed.reportedCachedInputTokens}::bigint,
    ${observed.openrouterAccountCostCredits}::numeric,${observed.observedRoundTripMs}::double precision)`);
    if(spendRoot)await tx.execute(sql`select app.ai_spend_settle(${admission.run_id}::uuid,null::bigint)`);
    // A terminal transport/token receipt does not establish USD cost. Keep monetary exposure held.
    if(lifecycle?.settled)await lifecycle.settled(tx,Object.freeze({runId:admission.run_id,succeeded,actualTokens:actual,accounting:observed}));}); }
   catch { throw new AiGatewayError('AI usage could not be confirmed. Its reservation remains held.'); }
  }
 }})});
 issuedConfigurations.set(resolved,{ctx,snapshot,feature,check,lifecycle,spendRoot});
 return resolved;
}

/** Opaque server-issued configuration. This alone grants no authority over HR source fields. */
export function governedAiConfig(ctx:SessionContext,snapshot:AiProviderSnapshot,feature:AiFeatureId):ResolvedAiConfig{
 return createGovernedAiConfig(ctx,snapshot,feature);
}

/** Join an extra trusted source check to the SAME admission transaction, before any reservation.
 * Serialized/copied configs cannot acquire this binding. Existing checks compose and cannot be
 * removed by adding another check. No check or transaction handle enters transport/model data.
 */
export function withAiAdmissionCheck(configuration:ResolvedAiConfig,feature:AiFeatureId,check:AiAdmissionCheck):ResolvedAiConfig{
 const issued=issuedConfigurations.get(configuration);
 if(!issued||issued.feature!==feature||typeof check!=='function')throw new AiGatewayError('The prepared AI request could not be confirmed.');
 const combined:AiAdmissionCheck=issued.check?async(tx,request)=>{await issued.check!(tx,request);await check(tx,request);}:check;
 return createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,combined,issued.lifecycle,issued.spendRoot);
}

/** Server-only durable correlation. Hooks run in admission/settlement transactions; failures roll back
 * their canonical writes. No hook or run identity enters the provider request. Config copies refuse. */
export function withAiAdmissionLifecycle(configuration:ResolvedAiConfig,feature:AiFeatureId,hooks:AiAdmissionLifecycle):ResolvedAiConfig{
 const issued=issuedConfigurations.get(configuration);
 if(!issued||issued.feature!==feature||!hooks||Object.keys(hooks).some(key=>key!=='admitted'&&key!=='settled')||
  (hooks.admitted!==undefined&&typeof hooks.admitted!=='function')||(hooks.settled!==undefined&&typeof hooks.settled!=='function'))throw new AiGatewayError('The prepared AI request could not be confirmed.');
 const captured=Object.freeze({admitted:hooks.admitted,settled:hooks.settled}),previous=issued.lifecycle;
 const composed:AiAdmissionLifecycle=Object.freeze({
  async admitted(tx,event){if(previous?.admitted)await previous.admitted(tx,event);if(captured.admitted)await captured.admitted(tx,event);},
  async settled(tx,event){if(previous?.settled)await previous.settled(tx,event);if(captured.settled)await captured.settled(tx,event);}
 });
 return createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,composed,issued.spendRoot);
}

/** Trusted source nominates an ACTUAL persisted candidate, never a browser-created budget/reset.
 * Both evaluation arms, reviewers and retries bind the same candidate root for its entire lifetime.
 * Existing source/lifecycle checks compose; no price, cap or transport grant is accepted here. */
export function bindStrictAiSpendRoot(configuration:ResolvedAiConfig,root:StrictAiSpendRoot):ResolvedAiConfig{
 const issued=issuedConfigurations.get(configuration),captured=captureStrictAiSpendRoot(root);
 if(!issued||issued.spendRoot&&(issued.spendRoot.rootTaskId!==captured.rootTaskId||issued.spendRoot.kind!==captured.kind))throw new AiGatewayError('The AI spend root could not be confirmed.');
 return createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,issued.lifecycle,captured);
}
