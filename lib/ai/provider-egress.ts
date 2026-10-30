/** Runtime disclosure dispatch capability. Only lib/ai/index.ts may issue it (caller-drift enforced).
 * A privacy-reviewed admission is not a reusable configuration flag: one exact logical request may
 * reach one provider serializer while its owning gateway call is still active. No payload is retained.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {AiGatewayError,type ConverseArgs,type GenerateArgs,type ImageReadArgs,type ResolvedAiConfig} from './types';
import type {AiAdmission,AiOperation} from './governance';
import {draftInputDigest} from './draft-input';
import {conversationInputDigest} from './conversation-input';
import {imageInputDigest} from './image-input';
import {readOpenRouterOptions} from './providers/openrouter-configuration';

type LogicalInput=GenerateArgs|ConverseArgs|ImageReadArgs;
type Dispatch={active:boolean;used:boolean;operation:AiOperation;configurationDigest:string;inputDigest:string|null};
const dispatch=new AsyncLocalStorage<Dispatch>();
const refused=():never=>{throw new AiGatewayError('The prepared AI provider dispatch could not be confirmed.');};

function plainProperties(value:object){
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return refused();
 for(const key of Reflect.ownKeys(value)){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!descriptor?.enumerable||!('value' in descriptor))return refused();
 }
}
function configurationDigest(cfg:ResolvedAiConfig){
 plainProperties(cfg);
 if(Object.keys(cfg).some(key=>!['provider','model','apiKey','providerOptions','gatewayBaseUrl','governance'].includes(key)))return refused();
 if(!['anthropic','google','openai','openrouter','ai_gateway'].includes(cfg.provider)||typeof cfg.model!=='string'||typeof cfg.apiKey!=='string')return refused();
 if(cfg.provider!=='openrouter'&&cfg.providerOptions!==undefined||cfg.provider!=='ai_gateway'&&cfg.gatewayBaseUrl!==undefined)return refused();
 const options=cfg.provider==='openrouter'?readOpenRouterOptions(cfg.providerOptions):null;
 return createHash('sha256').update(JSON.stringify([1,cfg.provider,cfg.model,options,cfg.gatewayBaseUrl??null])).update('\0').update(cfg.apiKey).digest('hex');
}
function logicalDigest(operation:AiOperation,args?:LogicalInput):string|null{
 if(operation==='probe'){if(args!==undefined)return refused();return null;}
 if(!args)return refused();plainProperties(args);
 if(operation==='draft'){
  const value=args as GenerateArgs;
  if(typeof value.system!=='string'||typeof value.prompt!=='string'||Object.keys(value).some(key=>!['system','prompt','maxTokens','timeoutMs','signal','onUsage','onObservation'].includes(key)))return refused();
  return draftInputDigest(value);
 }
 if(operation==='image'){
  const value=args as ImageReadArgs;
  if(!(value.data instanceof Uint8Array)||typeof value.mimeType!=='string'||!Number.isFinite(value.timeoutMs)||Object.keys(value).some(key=>!['data','mimeType','signal','timeoutMs','onUsage'].includes(key)))return refused();
  return imageInputDigest(value);
 }
 const {onObservation:_,...value}=args as ConverseArgs;
 return conversationInputDigest(value);
}
/** Issued only after the gateway's privacy provenance and deterministic admission have succeeded.
 * Reusing, nesting or retaining the ambient context never mints a second send. */
export async function withProviderEgressDispatch<T>(cfg:ResolvedAiConfig,request:Readonly<Pick<AiAdmission,'operation'|'inputDigest'>>,call:()=>Promise<T>):Promise<T>{
 plainProperties(request);
 if(Object.keys(request).some(key=>!['operation','inputDigest'].includes(key)))return refused();
 if(dispatch.getStore()?.active||!['draft','conversation','image','probe'].includes(request.operation))return refused();
 if(request.operation==='probe'?request.inputDigest!==undefined:typeof request.inputDigest!=='string'||!/^[a-f0-9]{64}$/.test(request.inputDigest))return refused();
 const state:Dispatch={active:true,used:false,operation:request.operation,configurationDigest:configurationDigest(cfg),inputDigest:request.inputDigest??null};
 return dispatch.run(state,async()=>{try{return await call();}finally{state.active=false;}});
}
/** Non-consuming preflight for the gateway route's async DNS/public-host check. */
export function assertProviderEgressDispatch(cfg:ResolvedAiConfig,operation:AiOperation,args?:LogicalInput):void{
 try{
  const state=dispatch.getStore();
  if(!state?.active||state.used||state.operation!==operation||state.configurationDigest!==configurationDigest(cfg)||state.inputDigest!==logicalDigest(operation,args))return refused();
 }catch{return refused();}
}
/** Native adapter serializer/SDK entry. Call synchronously immediately before constructing/sending
 * the fixed request; callbacks and cancellation do not add any outbound model content. */
export function consumeProviderEgressDispatch(cfg:ResolvedAiConfig,operation:AiOperation,args?:LogicalInput):void{
 assertProviderEgressDispatch(cfg,operation,args);dispatch.getStore()!.used=true;
}
/** OpenRouter has one final raw POST owner. Draft translation is accepted only in its exact fixed
 * one-user-message form; a probe or image permit cannot be repurposed into a completion. */
export function consumeOpenRouterProviderEgress(cfg:ResolvedAiConfig,args:ConverseArgs):void{
 const operation=dispatch.getStore()?.operation;
 if(operation==='draft'){
  if(args.system.length!==1||args.turns.length!==1||args.turns[0].role!=='user'||args.tools.length!==0||args.cacheKey!==undefined)return refused();
  consumeProviderEgressDispatch(cfg,'draft',{system:args.system[0],prompt:args.turns[0].content,maxTokens:args.maxTokens});
 }else if(operation==='conversation')consumeProviderEgressDispatch(cfg,'conversation',args);
 else return refused();
}
