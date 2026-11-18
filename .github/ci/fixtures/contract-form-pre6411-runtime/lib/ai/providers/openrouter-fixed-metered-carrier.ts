/** CONDITIONAL metered text carrier; no real endpoint, price or certificate is supplied.
 * Independent release review must establish a HARD native context ceiling including every billable input
 * unit even on rejected requests, and an output ceiling including all reasoning, plus complete billing/control invariants.
 * Model metadata, character estimates and an administrator's rate entry cannot establish this. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {AiGatewayError,type ConverseArgs,type ResolvedAiConfig} from '../types';
import type {AiAdmission} from '../governance';
import {aiSpendConfigurationDigest} from '../spend-receipt';
import {draftInputDigest} from '../draft-input';
import {conversationInputDigest} from '../conversation-input';
import type {CertifiedAiSpendEnvelope} from '../spend-allocation';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const FIXED_METERED_INVARIANTS=Object.freeze(['controlledWorkspace','accountMutationGoverned','noByok','noDefaultPlugins','noEnforcedPlugins','noPresetInjection','noServerTools','noPaidCacheWrites','noOtherCharges','zdrEndpoint','noTraining','parametersEnforced','exactEndpointOnly','hardNativeContextAllInput','completionIncludesAllReasoning','noContextExtensions','endpointMutationGoverned','completeBillingDimensions'] as const);
export const FIXED_METERED_CARRIER_SOURCE_DIGEST=digest(['openrouter_fixed_metered_text_v1',FIXED_METERED_INVARIANTS,'fixed-paid-model','whole-usd-per-million-enforced-caps-and-zero-request-price','single-exact-provider','single-inference-post','no-hidden-extensions',
 'https://openrouter.ai/docs/api_reference/parameters','https://openrouter.ai/docs/guides/routing/provider-selection','https://openrouter.ai/docs/guides/features/plugins','https://openrouter.ai/docs/guides/overview/auth/byok']);
export type MeteredContract=Readonly<{semantics:'all_native_input_and_all_generated_output_v1';nativeContextTokens:number;completionTokens:number;promptUsdPerMillion:number;completionUsdPerMillion:number;nativeContractDigest:string;endpointRevisionDigest:string;documentationDigest:string}>;
export type ReviewedMeteredCarrier=Readonly<{carrier:'openrouter_fixed_metered_text_v1';meterContract:MeteredContract;capabilityDigest:string;sourceDigest:string;configurationDigest:string;model:string;operation:'draft'|'conversation';endpointSlug:string;workspaceControlDigest:string;reviewEvidenceDigest:string;independentEvidenceDigest:string;expiresAt:string;invariants:Readonly<Record<typeof FIXED_METERED_INVARIANTS[number],true>>}>;
const unavailable=():never=>{throw new AiGatewayError('The reviewed AI inference carrier could not be confirmed.');};
const meteredModel=/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** FULL C input + FULL M output, independently of prompt length or a smaller requested output.
 * Whole USD/M prices make the native max_price numbers exact and the nano conversion integral. */
export function captureMeteredContract(value:unknown):MeteredContract{
 if(!value||typeof value!=='object'||Array.isArray(value))return unavailable();const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='completionTokens,completionUsdPerMillion,documentationDigest,endpointRevisionDigest,nativeContextTokens,nativeContractDigest,promptUsdPerMillion,semantics'||v.semantics!=='all_native_input_and_all_generated_output_v1'||
 ![v.nativeContractDigest,v.endpointRevisionDigest,v.documentationDigest].every(hash)||![v.nativeContextTokens,v.completionTokens,v.promptUsdPerMillion,v.completionUsdPerMillion].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0)||
 Number(v.nativeContextTokens)>1000000000||Number(v.completionTokens)>32768||Number(v.completionTokens)>Number(v.nativeContextTokens)||Number(v.promptUsdPerMillion)>1000000||Number(v.completionUsdPerMillion)>1000000)return unavailable();
 const result=Object.freeze({...v}) as MeteredContract;meteredReservationNanos(result);return result;
}
export function meteredReservationNanos(contract:MeteredContract):string{
 const total=(BigInt(contract.nativeContextTokens)*BigInt(contract.promptUsdPerMillion)+BigInt(contract.completionTokens)*BigInt(contract.completionUsdPerMillion))*BigInt(1000);
 if(total<=BigInt(0)||total>BigInt('9223372036854775807'))return unavailable();return total.toString();
}
export function captureReviewedMeteredCarrier(value:unknown):ReviewedMeteredCarrier{
 if(!value||typeof value!=='object'||Array.isArray(value))return unavailable();const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='capabilityDigest,carrier,configurationDigest,endpointSlug,expiresAt,independentEvidenceDigest,invariants,meterContract,model,operation,reviewEvidenceDigest,sourceDigest,workspaceControlDigest'||
  row.carrier!=='openrouter_fixed_metered_text_v1'||![row.capabilityDigest,row.configurationDigest,row.workspaceControlDigest,row.reviewEvidenceDigest,row.independentEvidenceDigest].every(hash)||row.reviewEvidenceDigest===row.independentEvidenceDigest||row.sourceDigest!==FIXED_METERED_CARRIER_SOURCE_DIGEST||
  typeof row.model!=='string'||row.model.length>200||!meteredModel.test(row.model)||row.model.toLowerCase().startsWith('openrouter/')||!['draft','conversation'].includes(String(row.operation))||typeof row.endpointSlug!=='string'||! /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(row.endpointSlug)||row.endpointSlug.length>128||
  typeof row.expiresAt!=='string'||!Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.now()||!row.invariants||typeof row.invariants!=='object'||Array.isArray(row.invariants))return unavailable();
 const invariants=row.invariants as Record<string,unknown>;if(Object.keys(invariants).sort().join(',')!==[...FIXED_METERED_INVARIANTS].sort().join(',')||FIXED_METERED_INVARIANTS.some(key=>invariants[key]!==true))return unavailable();
 const meterContract=captureMeteredContract(row.meterContract);return Object.freeze({...row,meterContract,invariants:Object.freeze({...invariants})}) as ReviewedMeteredCarrier;
}
type ReviewProof={profile:ReviewedMeteredCarrier;cfg:ResolvedAiConfig;request:Readonly<AiAdmission>;certified:boolean;dispatched:boolean};
const proofs=new WeakMap<object,ReviewProof>();
/** Trusted resolver bridge only. The proof has no ambient scope and cannot be posted/copied into
 * actual admission: the current-Tx resolver always selects its own private catalog record. */
export function issueReviewedMeteredProof(profile:ReviewedMeteredCarrier,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>):object{const proof=Object.freeze({});proofs.set(proof,{profile:captureReviewedMeteredCarrier(profile),cfg,request,certified:false,dispatched:false});return proof;}
export function currentReviewedMeteredEnvelope(cfg:ResolvedAiConfig,request:Readonly<AiAdmission>,proof?:object):CertifiedAiSpendEnvelope{
 const owned=proof?proofs.get(proof):null;if(!owned)throw new AiGatewayError('This provider route has no verified complete spend ceiling. Autonomous AI and evaluation requests are paused.');if(owned.certified||owned.cfg!==cfg||owned.request!==request||cfg.provider!=='openrouter'||!request.inputDigest||owned.profile.configurationDigest!==aiSpendConfigurationDigest(cfg)||owned.profile.model!==cfg.model||owned.profile.operation!==request.operation)return unavailable();owned.certified=true;
 // Reserve the complete reviewed native maxima, never an input token estimate.
 return Object.freeze({capabilityDigest:owned.profile.capabilityDigest,requestDigest:request.inputDigest,reservedNanos:meteredReservationNanos(owned.profile.meterContract)});
}
type Dispatch={profile:ReviewedMeteredCarrier;cfg:ResolvedAiConfig;request:Readonly<AiAdmission>;active:boolean;posts:number;bodyDigest:string|null};
const dispatch=new AsyncLocalStorage<Dispatch>();
export async function withReviewedMeteredDispatch<T>(proof:object,cfg:ResolvedAiConfig,request:Readonly<AiAdmission>,consume:()=>Promise<T>):Promise<T>{
 const owned=proofs.get(proof);if(!owned?.certified||owned.dispatched||owned.cfg!==cfg||owned.request!==request)return unavailable();owned.dispatched=true;
 const state:Dispatch={profile:captureReviewedMeteredCarrier(owned.profile),cfg,request,active:true,posts:0,bodyDigest:null};
 try{return await dispatch.run(state,async()=>{const result=await consume();if(state.posts!==1)return unavailable();return result;});}finally{state.active=false;}
}
/** Actual builder boundary: exact same captured request, text/client-functions only. No model/user
 * can supply price/routing fields. Account-enforced processing is excluded by reviewed controls,
 * not by pretending request-level plugin switches override organization policy. */
export function enforceReviewedMeteredBody(configuration:{model:string},args:ConverseArgs,body:Record<string,unknown>):Record<string,unknown>{
 const state=dispatch.getStore();if(!state)return body;if(!state.active||state.posts||state.profile.model!==configuration.model||Date.parse(state.profile.expiresAt)<=Date.now()||state.profile.configurationDigest!==aiSpendConfigurationDigest(state.cfg))return unavailable();
 let actual:string;
 if(state.request.operation==='draft'){
  if(args.system.length!==1||args.turns.length!==1||args.turns[0].role!=='user'||args.tools.length||args.cacheKey!==undefined)return unavailable();
  actual=draftInputDigest({system:args.system[0],prompt:args.turns[0].content,maxTokens:args.maxTokens});
 }else if(state.request.operation==='conversation'){if(args.cacheKey!==undefined||args.turns.some(turn=>turn.role==='assistant'&&turn.providerState!==undefined))return unavailable();actual=conversationInputDigest(args);}else return unavailable();
 if(actual!==state.request.inputDigest||body.model!==state.profile.model||body.stream!==false||Object.keys(body).some(key=>!['model','messages','stream','max_completion_tokens','provider','plugins','tools','tool_choice','parallel_tool_calls'].includes(key))||!Number.isSafeInteger(body.max_completion_tokens)||Number(body.max_completion_tokens)<1||Number(body.max_completion_tokens)>state.profile.meterContract.completionTokens||body.max_completion_tokens!==(args.maxTokens??2048))return unavailable();
 const tools=body.tools;if(tools!==undefined&&(!Array.isArray(tools)||tools.some(tool=>!tool||typeof tool!=='object'||(tool as {type?:unknown}).type!=='function')))return unavailable();
 const plugins=body.plugins;if(!Array.isArray(plugins)||plugins.some(plugin=>!plugin||typeof plugin!=='object'||Array.isArray(plugin)||Object.keys(plugin).sort().join(',')!=='enabled,id'||(plugin as {enabled?:unknown}).enabled!==false))return unavailable();
 const provider=body.provider as Record<string,unknown>;if(!provider||Object.keys(provider).some(key=>!['only','order','allow_fallbacks','require_parameters','data_collection','zdr','sort'].includes(key))||provider.require_parameters!==true||provider.data_collection!=='deny'||provider.zdr!==true||provider.allow_fallbacks!==false||JSON.stringify(provider.only)!==JSON.stringify([state.profile.endpointSlug])||JSON.stringify(provider.order)!==JSON.stringify([state.profile.endpointSlug]))return unavailable();
 const enforced={...body,provider:{...provider,only:[state.profile.endpointSlug],order:[state.profile.endpointSlug],allow_fallbacks:false,max_price:{prompt:state.profile.meterContract.promptUsdPerMillion,completion:state.profile.meterContract.completionUsdPerMillion,request:0}}};
 state.bodyDigest=digest(enforced);return enforced;
}
/** Exactly one POST consumes the actual private source scope. Copies, a different key/model/options,
 * body changes, late asynchronous work or a second dispatch refuse before fetch. */
export function consumeReviewedMeteredPost(cfg:ResolvedAiConfig,body:string):void{
 const state=dispatch.getStore();if(!state)return;
 if(!state.active||state.posts!==0||!state.bodyDigest||state.profile.configurationDigest!==aiSpendConfigurationDigest(cfg)||Date.parse(state.profile.expiresAt)<=Date.now())return unavailable();
 let parsed:unknown;try{parsed=JSON.parse(body);}catch{return unavailable();}if(digest(parsed)!==state.bodyDigest)return unavailable();state.posts++;
}
