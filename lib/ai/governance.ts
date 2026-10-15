import type { AiUsage,ResolvedAiConfig } from './types';
export type AiOperation='draft'|'conversation'|'image';
export type AiAdmission={operation:AiOperation;reservedTokens:number};
export type AiGovernance={run<T>(request:AiAdmission,call:(record:(usage:AiUsage)=>void)=>Promise<T>):Promise<T>};
/** Reservations are estimates, never presented as provider-reported usage. */
export const textReservation=(text:string,maxTokens=2048)=>Math.min(1000000000,new TextEncoder().encode(text).length+Math.max(0,maxTokens)+1024);
export function governed<T>(cfg:ResolvedAiConfig,request:AiAdmission,call:(record:(usage:AiUsage)=>void)=>Promise<T>){
 return cfg.governance?cfg.governance.run(request,call):call(()=>{});
}
