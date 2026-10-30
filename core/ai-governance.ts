import {privateLocalData} from '../lib/ai/provider-policy-shape';
import {privateTaskDescriptor} from '../lib/ai/provider-task-registry';
import {adjudicateSnapshotAnalysis,SNAPSHOT_ANALYSIS_CONTRACT} from '../lib/ai/provider-snapshot-policy';
import {captureConversationInput,conversationInputDigest} from '../lib/ai/conversation-input';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-request';
import type {ConverseArgs} from '../lib/ai/types';
import {adjudicatePrivateAnalysisResult} from '../lib/ai/provider-analysis-result';
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
import type { AiAdmission,AiGovernance } from '../lib/ai/governance';
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
const issuedConfigurations = new WeakMap<object, { ctx: SessionContext; snapshot: AiProviderSnapshot; feature: AiFeatureId; check?: AiAdmissionCheck;lifecycle?:AiAdmissionLifecycle;spendRoot?:StrictAiSpendRoot;observer?:AiRunObserver }>();

/** Opaque server-only provider/principal binding, not HR disclosure or effect authorization. */
function createGovernedAiConfig(ctx:SessionContext,snapshot:AiProviderSnapshot,feature:AiFeatureId,check?:AiAdmissionCheck,lifecycle?:AiAdmissionLifecycle,spendRoot?:StrictAiSpendRoot,observer?:AiRunObserver):ResolvedAiConfig{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 assertAiProviderSnapshot(snapshot,ctx);
 assertAiProviderSnapshotFeature(snapshot,feature);
 const cfg=snapshot.configuration;
 if(!isAiFeature(feature))throw new AiGatewayError('Unknown AI feature.');
 let resolved:ResolvedAiConfig=Object.freeze({...cfg,governance:Object.freeze({async run<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void,observe?:(observation:AiRunObservation)=>void)=>Promise<T>,outgoing:ResolvedAiConfig=cfg):Promise<T>{
  const capturedRequest=Object.freeze({operation:request.operation,reservedTokens:request.reservedTokens,
   ...(request.inputDigest===undefined?{}:{inputDigest:request.inputDigest})});
  if(!['draft','conversation','image'].includes(capturedRequest.operation)||!Number.isSafeInteger(capturedRequest.reservedTokens)||capturedRequest.reservedTokens<0||capturedRequest.reservedTokens>1000000000||
   (capturedRequest.inputDigest!==undefined&&!/^[a-f0-9]{64}$/.test(capturedRequest.inputDigest)))throw new AiGatewayError('The prepared AI request could not be confirmed.');
  const preparedAdmission=await withTenant(ctx,async tx=>{
   await assertCurrentAiProviderSnapshotTx(tx,ctx,snapshot,outgoing);
   if(check)try{await check(tx,capturedRequest);}catch(error){
    if(error instanceof AiAllowanceError||error instanceof AiPrivacyGateError)throw error;
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
 if(observer)resolved=Object.freeze({...resolved,governance:Object.freeze({run:observeAiRun(resolved.governance!.run,observer)})});
 issuedConfigurations.set(resolved,{ctx,snapshot,feature,check,lifecycle,spendRoot,observer});
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
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,combined,issued.lifecycle,issued.spendRoot,issued.observer);
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
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,composed,issued.spendRoot,issued.observer);
 transferProviderPrivacyRequest(configuration,next);return next;
}

/** Trusted source nominates an ACTUAL persisted candidate, never a browser-created budget/reset.
 * Both evaluation arms, reviewers and retries bind the same candidate root for its entire lifetime.
 * Existing source/lifecycle checks compose; no price, cap or transport grant is accepted here. */
export function bindStrictAiSpendRoot(configuration:ResolvedAiConfig,root:StrictAiSpendRoot):ResolvedAiConfig{
 const issued=issuedConfigurations.get(configuration),captured=captureStrictAiSpendRoot(root);
 if(!issued||issued.spendRoot&&(issued.spendRoot.rootTaskId!==captured.rootTaskId||issued.spendRoot.kind!==captured.kind))throw new AiGatewayError('The AI spend root could not be confirmed.');
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,issued.lifecycle,captured,issued.observer);
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
 let source:unknown;
 try{source=await withTenant(ctx,async tx=>{
  await assertCurrentAiProviderSnapshotTx(tx,ctx,snapshot,configuration);
  return readSource(tx,ctx);
 });}catch{throw new AiGatewayError('The private AI source owner could not be confirmed.');}
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
  const args=Object.freeze({system:'Explain and compare only the supplied protected aggregate facts. Preserve uncertainty. Do not infer causes beyond the supplied verified relationships. Do not calculate money, invent exact values, identify people, assign ratings, or make employment decisions. Do not include prose. Return exactly JSON {"observations":[{"cohort":"cohort_a","metric":"a supplied metric"}],"comparisons":[{"left":{"cohort":"cohort_a","metric":"a supplied metric"},"right":{"cohort":"cohort_b","metric":"a supplied metric"},"relationship":"higher_change|lower_change|same_range"}]}. Use only supplied cohorts/metrics. Choose supported useful comparisons. Same range does not establish equal exact values.',
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
 try{const raw=await generateDraft(prepared.configuration,prepared.args);return adjudicatePrivateAnalysisResult(raw,prepared.args.prompt);}finally{prepared.dispose();}
}


export type AiRunObserver=Readonly<{
 beforeCall?:()=>void;usage?:(usage:AiUsage)=>void;observation?:(observation:AiRunObservation)=>void;settled?:()=>void;
}>;
function observed(result:unknown):void{if(result!==undefined)throw new AiGatewayError('The AI observation callback could not be confirmed.');}
function observeAiRun(base:AiGovernance['run'],observer:AiRunObserver):AiGovernance['run']{
 return async<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void,observe?:(observation:AiRunObservation)=>void)=>Promise<T>,configuration?:ResolvedAiConfig):Promise<T>=>{
  try{return await base(request,(record,observe)=>{
   if(observer.beforeCall?.()!==undefined)throw new AiGatewayError('The AI observation callback could not be confirmed.');
   return call(usage=>{record(usage);if(observer.usage?.(usage)!==undefined)throw new AiGatewayError('The AI usage observation could not be confirmed.');},value=>{observe?.(value);if(observer.observation?.(value)!==undefined)throw new AiGatewayError('The AI charge observation could not be confirmed.');});
  },configuration);}finally{if(observer.settled?.()!==undefined)throw new AiGatewayError('The AI observation completion could not be confirmed.');}
 };
}
/** Canonical operational observer. No authority is added; source/access/spend/privacy checks retain
 * their original owner and ordering. A copied config/run wrapper cannot acquire issued provenance. */
export function withAiRunObserver(configuration:ResolvedAiConfig,hooks:AiRunObserver):ResolvedAiConfig{
 const issued=issuedConfigurations.get(configuration);
 if(!issued||!hooks||typeof hooks!=='object'||Object.keys(hooks).some(key=>!['beforeCall','usage','observation','settled'].includes(key)))throw new AiGatewayError('The AI observer could not be confirmed.');
 const descriptors=Object.getOwnPropertyDescriptors(hooks);for(const descriptor of Object.values(descriptors))if(!('value'in descriptor)||typeof descriptor.value!=='function')throw new AiGatewayError('The AI observer could not be confirmed.');
 const previous=issued.observer,captured=Object.freeze({...hooks});
 const observer:AiRunObserver=previous?Object.freeze({
  beforeCall(){observed(previous.beforeCall?.());observed(captured.beforeCall?.());},usage(usage){observed(previous.usage?.(usage));observed(captured.usage?.(usage));},
  observation(value){observed(previous.observation?.(value));observed(captured.observation?.(value));},settled(){try{observed(previous.settled?.());}finally{observed(captured.settled?.());}}
 }):captured;
 const next=createGovernedAiConfig(issued.ctx,issued.snapshot,issued.feature,issued.check,issued.lifecycle,issued.spendRoot,observer);
 transferProviderPrivacyRequest(configuration,next);return next;
}
export type PreparedPrivateAiTask=Readonly<{configuration:ResolvedAiConfig;local:unknown;dispose:()=>void}>&(
 Readonly<{operation:'draft';args:GenerateArgs}>|Readonly<{operation:'conversation';args:ConverseArgs}>);
/** Strict source-policy preparation. Native owners supply actual authorized facts and are replayed
 * under the existing admission transaction. Descriptor/caller review flags cannot be posted. */
export async function preparePrivateAiTask(configuration:ResolvedAiConfig,contractId:string,readSource:(tx:Tx,ctx:SessionContext)=>Promise<unknown>):Promise<PreparedPrivateAiTask>{
 const issued=issuedConfigurations.get(configuration);if(!issued||typeof readSource!=='function')throw new AiPrivacyGateError('unsupported');
 const {ctx,snapshot,feature}=issued;
 let source:unknown;
 try{source=await withTenant(ctx,async tx=>{await assertCurrentAiProviderSnapshotTx(tx,ctx,snapshot,configuration);return readSource(tx,ctx);});}
 catch(error){if(error instanceof AiPrivacyGateError||error instanceof AiAllowanceError)throw error;throw new AiPrivacyGateError('source');}
 const descriptor=privateTaskDescriptor(contractId,feature,source),fingerprint=descriptor.fingerprint(source),captured=descriptor.capture(source),operation=descriptor.operation;
 try{
 const local=privateLocalData(captured.local);
 let args:GenerateArgs|ConverseArgs;
 if(operation==='conversation')args=captureConversationInput(captured.args as ConverseArgs);
 else{
  const value=captured.args as GenerateArgs,properties=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(properties).some(key=>!['system','prompt','maxTokens','timeoutMs'].includes(key))||Object.values(properties).some(item=>!('value'in item))||typeof value.system!=='string'||typeof value.prompt!=='string'||value.system.length>65536||value.prompt.length>262144)throw new AiPrivacyGateError('unsupported');
  const maxTokens=value.maxTokens??2048;if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>1000000||value.timeoutMs!==undefined&&(!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1||value.timeoutMs>1200000))throw new AiPrivacyGateError('unsupported');
  args=Object.freeze({system:value.system,prompt:value.prompt,maxTokens,...(value.timeoutMs===undefined?{}:{timeoutMs:value.timeoutMs})});
 }
 const inputDigest=operation==='draft'?draftInputDigest(args as GenerateArgs):conversationInputDigest(args as ConverseArgs),expiresAt=Math.min(snapshot.preparedAt+300000,Date.now()+300000),deadline=performance.now()+Math.max(0,expiresAt-Date.now());let disposed=false;
 if(descriptor.fingerprint(source)!==fingerprint)throw new AiPrivacyGateError('source');
 const next=withAiAdmissionCheck(configuration,feature,async(tx,request)=>{
  if(disposed||Date.now()>=expiresAt||performance.now()>=deadline||request.operation!==operation||request.inputDigest!==inputDigest)throw new AiPrivacyGateError('source');
  const current=await readSource(tx,ctx);if(descriptor.fingerprint(current)!==fingerprint)throw new AiPrivacyGateError('source');
 });
 bindProviderPrivacyRequest(next,{feature,operation,inputDigest,contractId,sourceDigest:PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST,expiresAt});
 const dispose=()=>{if(disposed)return;disposed=true;revokeProviderPrivacyRequest(next);captured.retire?.();};
 return Object.freeze({configuration:next,operation,args,local,dispose}) as PreparedPrivateAiTask;
 }catch(error){captured.retire?.();throw error;}
}
/** Analysis-only adapter for closed current snapshot contracts; no model wording becomes HR truth. */
export async function generatePrivateAiTaskAnalysis(configuration:ResolvedAiConfig,contractId:string,readSource:(tx:Tx,ctx:SessionContext)=>Promise<unknown>):Promise<string>{
 if(contractId!==SNAPSHOT_ANALYSIS_CONTRACT)throw new AiPrivacyGateError('unsupported');
 const prepared=await preparePrivateAiTask(configuration,contractId,readSource);
 try{if(prepared.operation!=='draft')throw new AiPrivacyGateError('unsupported');const raw=await generateDraft(prepared.configuration,prepared.args);return adjudicateSnapshotAnalysis(raw,prepared.local);}finally{prepared.dispose();}
}
