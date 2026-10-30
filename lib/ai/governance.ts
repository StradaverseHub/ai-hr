import {transferProviderPrivacyRequest} from './provider-privacy-request';
import { AiGatewayError, type AiUsage, type AiRunObservation, type ResolvedAiConfig } from './types';
import { readOpenRouterOptions } from './providers/openrouter-configuration';
import { readGatewayOptions } from './providers/gateway-options';
export type AiOperation='draft'|'conversation'|'image'|'probe';
export type AiAdmission={operation:AiOperation;reservedTokens:number;inputDigest?:string};
export type AiGovernance={run<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void,observe?:(observation:AiRunObservation)=>void)=>Promise<T>,configuration?:ResolvedAiConfig):Promise<T>};
declare const probeBrand:unique symbol;
/** Operational connection checks only: no workload prompt, model turn or allowance bypass. */
export type UngovernedProbe=ResolvedAiConfig&{readonly [probeBrand]:true};
const probes=new WeakMap<ResolvedAiConfig,AiGovernance['run']>();
/** Only core/ai-config.ts may issue this capability; caller drift tests enforce that closure. */
export function createUngovernedProbe(cfg:ResolvedAiConfig,run:AiGovernance['run']):UngovernedProbe {
 const {governance:_,...configuration}=cfg;
 const probe=Object.freeze(configuration) as UngovernedProbe;
 probes.set(probe,run);return probe;
}
/** Reservations are estimates, never presented as provider-reported usage. */
export const textReservation=(text:string,maxTokens=2048)=>Math.min(1000000000,new TextEncoder().encode(text).length+Math.max(0,maxTokens)+1024);
export function governed<T>(cfg:ResolvedAiConfig,request:AiAdmission,call:(record:(usage:AiUsage)=>void,observe?:(observation:AiRunObservation)=>void)=>Promise<T>){
 const probe=probes.get(cfg);
 if(probe){if(request.operation!=='probe')throw new AiGatewayError('Connection probes cannot execute AI workloads.');return probe(request,call,cfg);}
 if(!cfg.governance||request.operation==='probe')throw new AiGatewayError('AI governance is required.');
 return cfg.governance.run(request,call,cfg);
}

/** Capture before an asynchronous admission. A retained or copied config must not retarget the
 * transport after its original key/model/routes were checked. This alone grants no authority.
 */
export function captureAiConfig(cfg: ResolvedAiConfig): ResolvedAiConfig {
 try {
  const provider=cfg.provider,model=cfg.model,apiKey=cfg.apiKey;
  const source=cfg.governance;
  const run:AiGovernance['run']|undefined=source?.run.bind(source);
  const providerOptions=provider==='openrouter'?readOpenRouterOptions(cfg.providerOptions):undefined;
  if(provider!=='openrouter'&&cfg.providerOptions!==undefined)throw Error();
  // 0661: only an ai_gateway carries an address, and it is re-validated here like OpenRouter's routes.
  const gatewayBaseUrl=provider==='ai_gateway'?readGatewayOptions({version:1,baseUrl:cfg.gatewayBaseUrl}).baseUrl:undefined;
  if(provider!=='ai_gateway'&&cfg.gatewayBaseUrl!==undefined)throw Error();
  const captured=Object.freeze({provider,model,apiKey,...(providerOptions?{providerOptions}:{}),...(gatewayBaseUrl?{gatewayBaseUrl}:{}),
   ...(run?{governance:Object.freeze({run})}:{})});
  const probe=probes.get(cfg);if(probe)probes.set(captured,probe);
  transferProviderPrivacyRequest(cfg,captured);
  return captured;
 }catch{throw new AiGatewayError('The current AI configuration could not be confirmed.');}
}
