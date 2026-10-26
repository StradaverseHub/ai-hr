/** One provider receipt per admitted nonstreaming request. Never add duplicate terminal counters/costs. */
import type {AiProvider,AiRunObservation,AiUsage} from './types';
export type AiObservationStatus='missing'|'reported'|'conflicting'|'invalid';
export type AiRunAccounting=Readonly<{providerObservationStatus:AiObservationStatus;reportedInputTokens:number|null;
 reportedOutputTokens:number|null;reportedCachedInputTokens:number|null;openrouterAccountCostCredits:number|null;observedRoundTripMs:number|null}>;
const finite=(value:unknown)=>value===null||(typeof value==='number'&&Number.isFinite(value)&&value>=0);
function capture(value:unknown):AiRunObservation|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='accountCostCredits,accountCostUnit,elapsedMs,provider,usage,version'||row.version!==1||row.provider!=='openrouter'||row.accountCostUnit!=='openrouter_account_credits'||!finite(row.accountCostCredits)||!finite(row.elapsedMs))return null;
 let usage:AiUsage|null=null;
 if(row.usage!==null){if(!row.usage||typeof row.usage!=='object'||Array.isArray(row.usage))return null;const u=row.usage as Record<string,unknown>;if(Object.keys(u).sort().join(',')!=='cachedInputTokens,inputTokens,outputTokens')return null;const values=[u.inputTokens,u.outputTokens,u.cachedInputTokens];if(!values.every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||values.reduce<number>((sum,n)=>sum+(n as number),0)>1000000000)return null;usage=Object.freeze({inputTokens:u.inputTokens as number,outputTokens:u.outputTokens as number,cachedInputTokens:u.cachedInputTokens as number});}
 return Object.freeze({version:1,provider:'openrouter',accountCostUnit:'openrouter_account_credits',usage,accountCostCredits:row.accountCostCredits as number|null,elapsedMs:row.elapsedMs as number|null});
}
export function createAiRunAccounting(expectedProvider:AiProvider){
 let status:AiObservationStatus='missing',receipt:AiRunObservation|null=null;
 return Object.freeze({observe(value:unknown){
  let next:AiRunObservation|null=null;try{next=capture(value);}catch{/* Only a bounded invalid status survives malformed callback data. */}
  if(!next||next.provider!==expectedProvider){status='invalid';receipt=null;return;}
  if(status==='invalid'||status==='conflicting')return;
  if(receipt&&JSON.stringify(receipt)!==JSON.stringify(next)){status='conflicting';receipt=null;return;}
  receipt=next;status='reported';
 },snapshot(actualTokens:number|null):AiRunAccounting{
  let final=status,current=receipt;
  if(current?.usage&&actualTokens!==current.usage.inputTokens+current.usage.outputTokens+current.usage.cachedInputTokens){final='invalid';current=null;}
  return Object.freeze({providerObservationStatus:final,reportedInputTokens:current?.usage?.inputTokens??null,reportedOutputTokens:current?.usage?.outputTokens??null,reportedCachedInputTokens:current?.usage?.cachedInputTokens??null,openrouterAccountCostCredits:current?.accountCostCredits??null,observedRoundTripMs:current?.elapsedMs??null});
 }});
}
