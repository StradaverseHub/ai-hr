/** CONDITIONAL reviewed inference carrier. No live route, certificate or account is supplied here.
 * Official contract reviewed27Oct2026: free variants + provider max_price; plugins/BYOK/account
 * overrides require independent controlled-workspace evidence. A suffix/metadata response is NOT it. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {AiGatewayError,type ConverseArgs,type ResolvedAiConfig} from '../types';
import type {AiAdmission} from '../governance';
import {aiSpendConfigurationDigest} from '../spend-receipt';
import {draftInputDigest} from '../draft-input';
import {conversationInputDigest} from '../conversation-input';
import type {CertifiedAiSpendEnvelope} from '../spend-allocation';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const FIXED_FREE_INVARIANTS=Object.freeze(['controlledWorkspace','accountMutationGoverned','noByok','noDefaultPlugins','noEnforcedPlugins','noPresetInjection','noServerTools','noPaidCacheWrites','noOtherCharges','zdrEndpoint','noTraining','parametersEnforced','exactEndpointOnly'] as const);
export const FIXED_FREE_CARRIER_SOURCE_DIGEST=digest(['openrouter_fixed_free_text_v1',FIXED_FREE_INVARIANTS,'fixed-free-model','zero-prompt-completion-request-price','single-exact-provider','single-inference-post','no-hidden-extensions',
 'https://openrouter.ai/docs/guides/routing/model-variants/free','https://openrouter.ai/docs/guides/routing/provider-selection','https://openrouter.ai/docs/guides/features/plugins','https://openrouter.ai/docs/guides/overview/auth/byok']);
export type ReviewedFreeCarrier=Readonly<{capabilityDigest:string;sourceDigest:string;configurationDigest:string;model:string;operation:'draft'|'conversation';endpointSlug:string;workspaceControlDigest:string;reviewEvidenceDigest:string;independentEvidenceDigest:string;expiresAt:string;invariants:Readonly<Record<typeof FIXED_FREE_INVARIANTS[number],true>>}>;
const unavailable=():never=>{throw new AiGatewayError('The reviewed AI inference carrier could not be confirmed.');};
const freeModel=/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*:free$/;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function captureReviewedFreeCarrier(value:unknown):ReviewedFreeCarrier{
 if(!value||typeof value!=='object'||Array.isArray(value))return unavailable();const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='capabilityDigest,configurationDigest,endpointSlug,expiresAt,independentEvidenceDigest,invariants,model,operation,reviewEvidenceDigest,sourceDigest,workspaceControlDigest'||
  ![row.capabilityDigest,row.configurationDigest,row.workspaceControlDigest,row.reviewEvidenceDigest,row.independentEvidenceDigest].every(hash)||row.reviewEvidenceDigest===row.independentEvidenceDigest||row.sourceDigest!==FIXED_FREE_CARRIER_SOURCE_DIGEST||
  typeof row.model!=='string'||!freeModel.test(row.model)||row.model.toLowerCase().startsWith('openrouter/')||!['draft','conversation'].includes(String(row.operation))||typeof row.endpointSlug!=='string'||! /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(row.endpointSlug)||row.endpointSlug.length>128||
  typeof row.expiresAt!=='string'||!Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.now()||!row.invariants||typeof row.invariants!=='object'||Array.isArray(row.invariants))return unavailable();
 const invariants=row.invariants as Record<string,unknown>;if(Object.keys(invariants).sort().join(',')!==[...FIXED_FREE_INVARIANTS].sort().join(',')||FIXED_FREE_INVARIANTS.some(key=>invariants[key]!==true))return unavailable();
 return Object.freeze({...row,invariants:Object.freeze({...invariants})}) as ReviewedFreeCarrier;
}
type ReviewProof={profile:ReviewedFreeCarrier;cfg:ResolvedAiConfig;request:Readonly<AiAdmission>;certified:boolean;dispatched:boolean};
const proofs=new WeakMap<object,ReviewProof>();
/** Trusted resolver bridge only. The proof has no ambient scope and cannot be posted/copied into
 * actual admission: the current-Tx resolver always selects its own private catalog record. */
export function issueReviewedFreeProof(profile:ReviewedFreeCarrier,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>):object{const proof=Object.freeze({});proofs.set(proof,{profile:captureReviewedFreeCarrier(profile),cfg,request,certified:false,dispatched:false});return proof;}
export function currentReviewedFreeEnvelope(cfg:ResolvedAiConfig,request:Readonly<AiAdmission>,proof?:object):CertifiedAiSpendEnvelope{
 const owned=proof?proofs.get(proof):null;if(!owned)throw new AiGatewayError('This provider route has no verified complete spend ceiling. Autonomous AI and evaluation requests are paused.');if(owned.certified||owned.cfg!==cfg||owned.request!==request||cfg.provider!=='openrouter'||!request.inputDigest||owned.profile.configurationDigest!==aiSpendConfigurationDigest(cfg)||owned.profile.model!==cfg.model||owned.profile.operation!==request.operation)return unavailable();owned.certified=true;
 // Conservatively allocate one nano; authentic terminal evidence alone may reconcile zero.
 return Object.freeze({capabilityDigest:owned.profile.capabilityDigest,requestDigest:request.inputDigest,reservedNanos:'1'});
}
type Dispatch={profile:ReviewedFreeCarrier;cfg:ResolvedAiConfig;request:Readonly<AiAdmission>;active:boolean;posts:number;bodyDigest:string|null};
const dispatch=new AsyncLocalStorage<Dispatch>();
export async function withReviewedFreeDispatch<T>(proof:object,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>,consume:()=>Promise<T>):Promise<T>{
 const owned=proofs.get(proof);if(!owned?.certified||owned.dispatched||owned.cfg!==cfg||owned.request!==request)return unavailable();owned.dispatched=true;
 const state:Dispatch={profile:captureReviewedFreeCarrier(owned.profile),cfg,request,active:true,posts:0,bodyDigest:null};
 try{return await dispatch.run(state,async()=>{const result=await consume();if(state.posts!==1)return unavailable();return result;});}finally{state.active=false;}
}
/** Actual builder boundary: exact same captured request, text/client-functions only. No model/user
 * can supply price/routing fields. Account-enforced processing is excluded by reviewed controls,
 * not by pretending request-level plugin switches override organization policy. */
export function enforceReviewedFreeBody(configuration:{model:string},args:ConverseArgs,body:Record<string,unknown>):Record<string,unknown>{
 const state=dispatch.getStore();if(!state)return body;if(!state.active||state.posts||state.profile.model!==configuration.model||Date.parse(state.profile.expiresAt)<=Date.now()||state.profile.configurationDigest!==aiSpendConfigurationDigest(state.cfg))return unavailable();
 let actual:string;
 if(state.request.operation==='draft'){
  if(args.system.length!==1||args.turns.length!==1||args.turns[0].role!=='user'||args.tools.length||args.cacheKey!==undefined)return unavailable();
  actual=draftInputDigest({system:args.system[0],prompt:args.turns[0].content,maxTokens:args.maxTokens});
 }else if(state.request.operation==='conversation'){if(args.cacheKey!==undefined||args.turns.some(turn=>turn.role==='assistant'&&turn.providerState!==undefined))return unavailable();actual=conversationInputDigest(args);}else return unavailable();
 if(actual!==state.request.inputDigest||body.model!==state.profile.model||body.stream!==false||Object.keys(body).some(key=>!['model','messages','stream','max_completion_tokens','provider','plugins','tools','tool_choice','parallel_tool_calls'].includes(key))||!Number.isSafeInteger(body.max_completion_tokens)||Number(body.max_completion_tokens)<1||Number(body.max_completion_tokens)>32768)return unavailable();
 const tools=body.tools;if(tools!==undefined&&(!Array.isArray(tools)||tools.some(tool=>!tool||typeof tool!=='object'||(tool as {type?:unknown}).type!=='function')))return unavailable();
 const plugins=body.plugins;if(!Array.isArray(plugins)||plugins.some(plugin=>!plugin||typeof plugin!=='object'||Array.isArray(plugin)||Object.keys(plugin).sort().join(',')!=='enabled,id'||(plugin as {enabled?:unknown}).enabled!==false))return unavailable();
 const provider=body.provider as Record<string,unknown>;if(!provider||Object.keys(provider).some(key=>!['only','order','allow_fallbacks','require_parameters','data_collection','zdr','sort'].includes(key))||provider.require_parameters!==true||provider.data_collection!=='deny'||provider.zdr!==true||provider.allow_fallbacks!==false||JSON.stringify(provider.only)!==JSON.stringify([state.profile.endpointSlug])||JSON.stringify(provider.order)!==JSON.stringify([state.profile.endpointSlug]))return unavailable();
 const enforced={...body,provider:{...provider,only:[state.profile.endpointSlug],order:[state.profile.endpointSlug],allow_fallbacks:false,max_price:{prompt:0,completion:0,request:0}}};
 state.bodyDigest=digest(enforced);return enforced;
}
/** Exactly one POST consumes the actual private source scope. Copies, a different key/model/options,
 * body changes, late asynchronous work or a second dispatch refuse before fetch. */
export function consumeReviewedFreePost(cfg:ResolvedAiConfig,body:string):void{
 const state=dispatch.getStore();if(!state)return;
 if(!state.active||state.posts!==0||!state.bodyDigest||state.profile.configurationDigest!==aiSpendConfigurationDigest(cfg)||Date.parse(state.profile.expiresAt)<=Date.now())return unavailable();
 let parsed:unknown;try{parsed=JSON.parse(body);}catch{return unavailable();}if(digest(parsed)!==state.bodyDigest)return unavailable();state.posts++;
}
