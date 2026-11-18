/** Actual admission-Tx resolver for RELEASE-owned reviewed inference certificates. No record is
 * seeded, no app/admin/model can mint one, and model/key metadata is never control verification. */
import {createHmac} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
import {pgErrorChain} from '../lib/db-error';
import {AI_SPEND_CONTROL_REFUSALS,AiAdmissionRefusal,AiSpendControlError,sqlAdmissionRefusalCode,type AiAdmissionRefusalCode} from '../lib/ai/admission-refusal';
import type {AiAdmission} from '../lib/ai/governance';
import type {AiFeatureId} from '../lib/ai/features';
import type {StrictAiSpendRoot} from '../lib/ai/spend-allocation';
import {certifiedAiSpendEnvelope,type CertifiedAiSpendEnvelope} from '../lib/ai/spend-allocation';
import {aiSpendConfigurationDigest} from '../lib/ai/spend-receipt';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {captureReviewedFreeCarrier,FIXED_FREE_CARRIER_SOURCE_DIGEST,issueReviewedFreeProof,withReviewedFreeDispatch} from '../lib/ai/providers/openrouter-fixed-free-carrier';
import {captureReviewedMeteredCarrier,FIXED_METERED_CARRIER_SOURCE_DIGEST,issueReviewedMeteredProof,currentReviewedMeteredEnvelope,withReviewedMeteredDispatch} from '../lib/ai/providers/openrouter-fixed-metered-carrier';
const unavailable=():never=>{throw new AiAdmissionRefusal('spend_capability_unavailable','The current reviewed AI spend capability could not be confirmed.');};
/** The exact USD spend-control refusals RAISEd by migrations 0651/0654 (pinned against them by test). The SQL owns
 * each decision; this only gives it the product's typed AI control refusal. Unknown cost is never zero.
 * AiSpendControlError (a configured USD spend control refused admission before any provider call) IS the existing
 * typed AI control refusal; its closed `code` names only which fixed control refused. */
export {AI_SPEND_CONTROL_REFUSALS,AiSpendControlError} from '../lib/ai/admission-refusal';
/** One admission-transaction spend/admission statement. Drizzle's failure text is the whole SQL plus every bound
 * parameter, so a database refusal never leaves as raw text: the canonical spend/feature-pause refusals become the
 * typed AI control refusal, anything else the caller's generic client-safe refusal (no cause, like every
 * AiGatewayError) labelled only with the closed code of the exact constant SQL refusal. Typed AI errors pass
 * through unchanged. */
export async function aiSpendAdmissionStep<T>(step:()=>Promise<T>,fallback='The AI request could not be admitted.',fallbackCode:AiAdmissionRefusalCode='admission_unavailable'):Promise<T>{
 try{return await step();}
 catch(error){
  if(error instanceof AiGatewayError)throw error;
  const raised=pgErrorChain(error).find(link=>link.code==='P0001')?.message;
  if(raised==='AI spend task paused')throw new AiAllowanceError('paused');
  if(raised!==undefined&&(AI_SPEND_CONTROL_REFUSALS as readonly string[]).includes(raised))throw new AiSpendControlError(raised);
  throw new AiAdmissionRefusal(sqlAdmissionRefusalCode(raised,fallbackCode),fallback);
 }
}
type Owned={configuration:ResolvedAiConfig;request:Readonly<AiAdmission>;proof:object|null;carrier:'source'|'free'|'metered';active:boolean};
const issued=new WeakMap<object,Owned>();
function keep(envelope:CertifiedAiSpendEnvelope,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>,proof:object|null,carrier:'source'|'free'|'metered'='source'){
 if(!envelope||Object.keys(envelope).sort().join(',')!=='capabilityDigest,requestDigest,reservedNanos'||! /^[a-f0-9]{64}$/.test(envelope.capabilityDigest)||envelope.requestDigest!==request.inputDigest||! /^\d{1,19}$/.test(envelope.reservedNanos)||BigInt(envelope.reservedNanos)<=BigInt('0')||BigInt(envelope.reservedNanos)>BigInt('9223372036854775807'))return unavailable();
 const captured=Object.freeze({...envelope});issued.set(captured,{configuration:cfg,request,proof,carrier,active:true});return captured;
}
/** Actual SAME-admission-Tx policy, never a posted/configuration 'unlimited' flag. SQL owns the
 * current principal, canonical company set, root validation and ai-control interval through ai_admit.
 * Any finite applicable dimension, including0, still requires the reviewed monetary carrier. */
export async function resolveAiSpendPolicyTx(tx:Tx,ctx:SessionContext,feature:AiFeatureId,root?:StrictAiSpendRoot):Promise<Readonly<{requiresMonetaryCeiling:boolean}>>{
 if(!ctx.userId)throw new AiAdmissionRefusal('admission_policy_unavailable','The current reviewed AI spend capability could not be confirmed.');
 const rows=await aiSpendAdmissionStep(()=>tx.execute<{monetary_required:boolean}>(sql`select monetary_required from app.ai_spend_policy_context(${feature},${root?.rootTaskId??null}::uuid,${root?.kind??null})`),undefined,'admission_policy_unavailable');
 if(rows.length!==1||typeof rows[0].monetary_required!=='boolean')throw new AiAdmissionRefusal('admission_policy_unavailable','The current reviewed AI spend capability could not be confirmed.');
 if(rows[0].monetary_required&&!root)throw new AiAdmissionRefusal('spend_limit_requires_root','The current reviewed AI spend capability could not be confirmed.');
 return Object.freeze({requiresMonetaryCeiling:rows[0].monetary_required});
}
export async function resolveReviewedAiSpendCapabilityTx(tx:Tx,ctx:SessionContext,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>):Promise<CertifiedAiSpendEnvelope>{
 // Existing independently source-certified carriers (including exact test-process fixtures) may
 // supply a capability. The production selector refuses unless a reviewed carrier scope exists.
 // No production test flag or raw configuration can change that selector's source contract.
 try{return keep(certifiedAiSpendEnvelope(cfg,request),cfg,request,null);}catch(error){if(!(error instanceof AiGatewayError))throw error;}
 if(!ctx.userId||cfg.provider!=='openrouter'||!['draft','conversation'].includes(request.operation)||!request.inputDigest)return unavailable();
 const signer=process.env.AI_SPEND_RECEIPT_KEY_ID,secret=process.env.AI_SPEND_RECEIPT_SIGNING_KEY,configurationDigest=aiSpendConfigurationDigest(cfg);
 if(!signer||! /^[A-Za-z0-9_-]{1,64}$/.test(signer)||!secret||! /^[a-f0-9]{64}$/i.test(secret))return unavailable();
 const signature=createHmac('sha256',Buffer.from(secret,'hex')).update(['aihr.reviewed-carrier-signer.v1',ctx.tenantId,ctx.userId,configurationDigest,request.inputDigest].join('\n'),'utf8').digest('hex');
 const metered=!cfg.model.endsWith(':free');
 if(metered){
  const rows=await aiSpendAdmissionStep(()=>tx.execute<{profile:unknown}>(sql`select profile from app.ai_spend_reviewed_metered_carrier(${configurationDigest},${cfg.model},${request.operation},${FIXED_METERED_CARRIER_SOURCE_DIGEST},${signer},${signature},${request.inputDigest})`),'The current reviewed AI spend capability could not be confirmed.','spend_capability_unavailable');
  if(rows.length!==1)return unavailable();const profile=captureReviewedMeteredCarrier(rows[0].profile),routing=readOpenRouterOptions(cfg.providerOptions).routing;
  if(profile.configurationDigest!==aiSpendConfigurationDigest(cfg)||profile.model!==cfg.model||profile.operation!==request.operation||routing.allowedProviders.length!==1||routing.allowedProviders[0]!==profile.endpointSlug||routing.allowFallbacks)return unavailable();
  const proof=issueReviewedMeteredProof(profile,cfg,request),envelope=currentReviewedMeteredEnvelope(cfg,request,proof);return keep(envelope,cfg,request,proof,'metered');
 }
 const rows=await aiSpendAdmissionStep(()=>tx.execute<{profile:unknown}>(sql`select profile from app.ai_spend_reviewed_carrier(${configurationDigest},${cfg.model},${request.operation},${FIXED_FREE_CARRIER_SOURCE_DIGEST},${signer},${signature},${request.inputDigest})`),'The current reviewed AI spend capability could not be confirmed.','spend_capability_unavailable');
 if(rows.length!==1)return unavailable();const profile=captureReviewedFreeCarrier(rows[0].profile),routing=readOpenRouterOptions(cfg.providerOptions).routing;
 if(profile.configurationDigest!==aiSpendConfigurationDigest(cfg)||profile.model!==cfg.model||profile.operation!==request.operation||routing.allowedProviders.length!==1||routing.allowedProviders[0]!==profile.endpointSlug||routing.allowFallbacks)return unavailable();
 const proof=issueReviewedFreeProof(profile,cfg,request),envelope=certifiedAiSpendEnvelope(cfg,request,proof);return keep(envelope,cfg,request,proof,'free');
}
/** Only the exact envelope returned by the current source resolver can dispatch once. This is
 * independent of monetary receipt signing; the actual terminal transport must still establish cost. */
export async function withReviewedAiSpendDispatch<T>(envelope:CertifiedAiSpendEnvelope,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>,consume:()=>Promise<T>):Promise<T>{
 const owner=issued.get(envelope);if(!owner?.active||owner.configuration!==cfg||owner.request!==request)return unavailable();owner.active=false;
 if(owner.carrier==='metered'&&owner.proof)return withReviewedMeteredDispatch(owner.proof,cfg,request,consume);
 return owner.proof?withReviewedFreeDispatch(owner.proof,cfg,request,consume):consume();
}
