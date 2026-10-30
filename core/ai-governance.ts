import {createHash} from 'node:crypto';
import {draftInputDigest} from '../lib/ai/draft-input';
import {generateDraft} from '../lib/ai';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from '../lib/ai/provider-data-source-manifest';
import {prepareProviderAnalysis,inspectPreparedProviderAnalysis,retireProviderAnalysis,fingerprintProviderAnalysisSource} from '../lib/ai/provider-analysis-policy';
import type {GenerateArgs} from '../lib/ai/types';
import {bindProviderPrivacyRequest,transferProviderPrivacyRequest,assertProviderPrivacyRequest,revokeProviderPrivacyRequest} from '../lib/ai/provider-privacy-request';
import {createAiRunAccounting,type AiRunAccounting} from '../lib/ai/run-accounting';
import { sql } from 'drizzle-orm';
import { withTenant,type SessionContext,type Tx } from '../db/client';
import { AiGatewayError,AiAllowanceError,type AiUsage,type AiRunObservation,type ResolvedAiConfig } from '../lib/ai/types';
import { AI_FEATURES,isAiFeature,type AiFeatureId } from '../lib/ai/features';

import { resolveEntitlementsTx, getSetting } from './entitlements';
import { assertAiProviderSnapshot, assertAiProviderSnapshotFeature, assertCurrentAiProviderSnapshotTx, type AiProviderSnapshot } from './ai-provider-snapshot';
import type { AiAdmission } from '../lib/ai/governance';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {captureStrictAiSpendRoot,requiresAiTaskRoot,type StrictAiSpendRoot} from '../lib/ai/spend-allocation';
export type {StrictAiSpendRoot} from '../lib/ai/spend-allocation';
import {aiSpendAdmissionStep,resolveAiSpendPolicyTx,resolveReviewedAiSpendCapabilityTx,withReviewedAiSpendDispatch} from './ai-spend-capability';
import {aiSpendConfigurationDigest,createAiSpendReceiptScope} from '../lib/ai/spend-receipt';

/** Reuse the gateway's fresh setting/platform-kill resolution for deterministic action checks. */
async function forcedPauseTx(tx:Tx,ctx:SessionContext,feature:AiFeatureId):Promise<boolean>{
 const definition=AI_FEATURES.find(f=>f.id===feature)!;
 if(!definition.setting)return false;
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 return getSetting(fresh,definition.setting)!==true;
}

/**
 * Runtime pause prerequisite used by human action services (migration 0621), NEVER action authority.
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
  const preparedAdmission=await withTenant(ctx,async tx=>{
   await assertCurrentAiProviderSnapshotTx(tx,ctx,snapshot,outgoing);
   if(check)try{await check(tx,capturedRequest);}catch(error){
    if(error instanceof AiAllowanceError)throw error;
    throw new AiGatewayError('The current AI source access could not be confirmed.');
   }
   assertAiProviderSnapshot(snapshot,ctx);
   assertAiProviderSnapshotFeature(snapshot,feature);
   assertProviderPrivacyRequest(outgoing,capturedRequest.operation,capturedRequest.inputDigest,feature);
   const nativeRootRequired=requiresAiTaskRoot(feature)||spendRoot!==undefined;
   if(nativeRootRequired&&!spendRoot)throw new AiGatewayError('The autonomous AI spend root could not be confirmed.');
   // Every admission checks ALL applicable monetary scopes under the actual ai-control interval.
   // No configured USD cap promises no USD ceiling, not a pause/auth/token/concurrency bypass.
   // Any finite dimension still requires the unchanged reviewed carrier and reservation contract.
   const moneyPolicy=await resolveAiSpendPolicyTx(tx,ctx,feature,spendRoot);
   const envelope=moneyPolicy.requiresMonetaryCeiling?await resolveReviewedAiSpendCapabilityTx(tx,ctx,outgoing,capturedRequest):null;
   if(envelope&&(!ctx.userId||envelope.requestDigest!==capturedRequest.inputDigest))throw new AiGatewayError('The exact AI spend request could not be confirmed.');
   const forcedPause=await forcedPauseTx(tx,ctx,feature);
   // Admission and spend SQL refusals leave as typed AI refusals, never as driver text (SQL plus parameters).
   const rows=await aiSpendAdmissionStep(()=>tx.execute<{run_id:string;allowed:boolean;blocked_reason:string|null}>(sql`select * from app.ai_admit(${feature},${capturedRequest.operation},${cfg.provider},${cfg.model},${capturedRequest.reservedTokens}::bigint,${forcedPause})`));
   if(rows[0]?.allowed&&envelope&&spendRoot)await aiSpendAdmissionStep(()=>tx.execute(sql`select app.ai_spend_reserve(${rows[0].run_id}::uuid,${spendRoot.rootTaskId}::uuid,${spendRoot.kind},${envelope.capabilityDigest},${envelope.requestDigest},${envelope.reservedNanos}::bigint,${aiSpendConfigurationDigest(outgoing)})`));
   // Root custody and real run association are mandatory even without monetary certification.
   // Unknown unpriced history persists; a later finite cap cannot retrospectively count it as zero.
   if(rows[0]?.allowed)await aiSpendAdmissionStep(()=>tx.execute(sql`select app.ai_spend_record_admission(${rows[0].run_id}::uuid,${spendRoot?.rootTaskId??null}::uuid,${spendRoot?.kind??null},${capturedRequest.inputDigest??null},${aiSpendConfigurationDigest(outgoing)})`));
   if(rows[0]?.allowed&&lifecycle?.admitted)await lifecycle.admitted(tx,Object.freeze({runId:rows[0].run_id,request:capturedRequest}));
   return{rows,envelope};
  });
  const[admission]=preparedAdmission.rows,spendEnvelope=preparedAdmission.envelope;
  if(!admission?.allowed){
   const reason=admission?.blocked_reason;
   if(reason==='paused'||reason==='daily_limit'||reason==='monthly_limit'||reason==='concurrent_limit')throw new AiAllowanceError(reason);
   throw new AiGatewayError('The AI request could not be admitted.');
  }
  let actual:number|null=null;
  const accounting=createAiRunAccounting(cfg.provider);
  const record=(usage:AiUsage)=>{const values=[usage.inputTokens,usage.outputTokens,usage.cachedInputTokens];if(values.every(n=>Number.isSafeInteger(n)&&n>=0))actual=values.reduce((a,b)=>a+b,0);};
  const scope=spendRoot&&spendEnvelope&&ctx.userId?createAiSpendReceiptScope({tenantId:ctx.tenantId,userId:ctx.userId,runId:admission.run_id,rootTaskId:spendRoot.rootTaskId,requestDigest:spendEnvelope.requestDigest,capabilityDigest:spendEnvelope.capabilityDigest,configurationDigest:aiSpendConfigurationDigest(outgoing)}):null;
  let succeeded=false;
  try{const dispatch=()=>scope?scope.run(()=>call(record,accounting.observe)):call(record,accounting.observe);const result=await(spendEnvelope?withReviewedAiSpendDispatch(spendEnvelope,outgoing,capturedRequest,dispatch):dispatch());succeeded=true;return result;}
  finally{
   // A failed write is visible and leaves the reservation held; it must never erase unconfirmed usage.
   let breach=false;
   try { const observed=accounting.snapshot(actual),receipt=scope?.receipt();await withTenant(ctx,async tx=>{
    // Same order as admission. This is ownership only: role revocation must not erase actual usage.
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    await tx.execute(sql`select app.ai_settle_observed(${admission.run_id}::uuid,${succeeded},${actual}::bigint,
    ${observed.providerObservationStatus},${observed.reportedInputTokens}::bigint,${observed.reportedOutputTokens}::bigint,${observed.reportedCachedInputTokens}::bigint,
    ${observed.openrouterAccountCostCredits}::numeric,${observed.observedRoundTripMs}::double precision)`);
    if(spendEnvelope&&spendRoot){if(receipt){const[state]=await tx.execute<{state:string}>(sql`select app.ai_spend_reconcile_receipt(${receipt.payload},${receipt.signature}) as state`);breach=state?.state==='breach';}else await tx.execute(sql`select app.ai_spend_settle(${admission.run_id}::uuid,null::bigint)`);}
    // A terminal transport/token receipt does not establish USD cost. Keep monetary exposure held.
    if(lifecycle?.settled)await lifecycle.settled(tx,Object.freeze({runId:admission.run_id,succeeded,actualTokens:actual,accounting:observed}));}); }
   catch { throw new AiGatewayError('AI usage could not be confirmed. Its reservation remains held.'); }
   if(breach)throw new AiGatewayError('The AI inference charge exceeded its verified allocation ceiling. Further strict admissions are paused.');
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
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,combined,issued.lifecycle,issued.spendRoot);
 transferProviderPrivacyRequest(configuration,next);return next;
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
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,composed,issued.spendRoot);
 transferProviderPrivacyRequest(configuration,next);return next;
}

/** Trusted source nominates an ACTUAL persisted candidate, never a browser-created budget/reset.
 * Both evaluation arms, reviewers and retries bind the same candidate root for its entire lifetime.
 * Existing source/lifecycle checks compose; no price, cap or transport grant is accepted here. */
export function bindStrictAiSpendRoot(configuration:ResolvedAiConfig,root:StrictAiSpendRoot):ResolvedAiConfig{
 const issued=issuedConfigurations.get(configuration),captured=captureStrictAiSpendRoot(root);
 if(!issued||issued.spendRoot&&(issued.spendRoot.rootTaskId!==captured.rootTaskId||issued.spendRoot.kind!==captured.kind))throw new AiGatewayError('The AI spend root could not be confirmed.');
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,issued.lifecycle,captured);
 transferProviderPrivacyRequest(configuration,next);return next;
}


/** A native owner supplies an authorized, complete source projection, not user-posted facts.
 * It must perform its own module/subject/company permissions every time it is called. Preparation
 * and replay both run under the current provider/principal transaction. No callback enters model data.
 * Current contract accepts only closed aggregate categories; arbitrary text/images never fall back.
 */
export async function preparePrivateAiAnalysis(configuration:ResolvedAiConfig,readSource:(tx:Tx,ctx:SessionContext)=>Promise<unknown>):Promise<Readonly<{configuration:ResolvedAiConfig;args:GenerateArgs;dispose:()=>void}>>{
 const issued=issuedConfigurations.get(configuration);
 if(!issued||typeof readSource!=='function')throw new AiGatewayError('The private AI source owner could not be confirmed.');
 const {ctx,snapshot,feature}=issued;
 const source=await withTenant(ctx,async tx=>{
  await assertCurrentAiProviderSnapshotTx(tx,ctx,snapshot,configuration);
  return readSource(tx,ctx);
 });
 const sourceFingerprint=fingerprintProviderAnalysisSource(source);
 const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const binding=Object.freeze({feature,operation:'draft' as const,contractId:'aggregate_comparison_analysis_v1' as const,
  principalDigest:snapshot.principal,scopeDigest:hash([ctx.tenantId,ctx.personId??null,ctx.roles??null,ctx.grants??null]),
  providerSnapshotDigest:snapshot.fingerprint,sourceFingerprint,expiresAt:Math.min(snapshot.preparedAt+300000,Date.now()+300000)});
 const prepared=prepareProviderAnalysis(binding,source);
 try{
  const projection=inspectPreparedProviderAnalysis(prepared,binding);
  if(projection.originalSourceFingerprint!==sourceFingerprint)throw new AiGatewayError('The private AI source could not be confirmed.');
  // This fixed prompt has no tenant-authored strings, history, user prompt, tool catalogue or state.
  const args=Object.freeze({system:'Explain and compare only the supplied protected aggregate facts. Preserve uncertainty. Do not infer causes beyond the supplied verified relationships. Do not calculate money, invent exact values, identify people, assign ratings, or make employment decisions. State which comparisons the coarse categories cannot support.',
   prompt:projection.json,maxTokens:1024});
  const next=withAiAdmissionCheck(configuration,feature,async(tx,request)=>{
   inspectPreparedProviderAnalysis(prepared,binding);
   if(request.operation!=='draft'||request.inputDigest!==draftInputDigest(args))throw new AiGatewayError('The private AI request changed.');
   if(fingerprintProviderAnalysisSource(await readSource(tx,ctx))!==sourceFingerprint)throw new AiGatewayError('The private AI source changed.');
  });
  bindProviderPrivacyRequest(next,{feature,operation:'draft',inputDigest:draftInputDigest(args),contractId:binding.contractId,
   sourceDigest:PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST,expiresAt:binding.expiresAt});
  return Object.freeze({configuration:next,args,dispose:()=>{revokeProviderPrivacyRequest(next);retireProviderAnalysis(prepared);}});
 }catch(error){retireProviderAnalysis(prepared);throw error;}
}

/** Native-source analysis entry point, usable across the feature/domain registry. Output is an
 * untrusted explanation only: no canonical source, calculation, rating or effect authority is added.
 */
export async function generatePrivateAiAnalysis(configuration:ResolvedAiConfig,readSource:(tx:Tx,ctx:SessionContext)=>Promise<unknown>):Promise<string>{
 const prepared=await preparePrivateAiAnalysis(configuration,readSource);
 try{return await generateDraft(prepared.configuration,prepared.args);}finally{prepared.dispose();}
}
