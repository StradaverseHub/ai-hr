import { AiGatewayError, type AiUsage, type ResolvedAiConfig } from './types';
import { readOpenRouterOptions } from './providers/openrouter-configuration';
export type AiOperation='draft'|'conversation'|'image';
export type AiAdmission={operation:AiOperation;reservedTokens:number};
export type AiGovernance={run<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void)=>Promise<T>,configuration?:ResolvedAiConfig):Promise<T>};
/** Reservations are estimates, never presented as provider-reported usage. */
export const textReservation=(text:string,maxTokens=2048)=>Math.min(1000000000,new TextEncoder().encode(text).length+Math.max(0,maxTokens)+1024);
export function governed<T>(cfg:ResolvedAiConfig,request:AiAdmission,call:(record:(usage:AiUsage)=>void)=>Promise<T>){
 return cfg.governance?cfg.governance.run(request,call,cfg):call(()=>{});
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
  return Object.freeze({provider,model,apiKey,...(providerOptions?{providerOptions}:{}),
   ...(run?{governance:Object.freeze({run})}:{})});
 }catch{throw new AiGatewayError('The current AI configuration could not be confirmed.');}
}
