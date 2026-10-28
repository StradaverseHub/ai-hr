/** Private server transport provenance + purpose-separated HMAC. No prompt/output/key reaches SQL.
 * A structural onObservation callback cannot create a receipt. Operator provisioning of the dedicated
 * signing/verifier key is REQUIRED separately; this module never writes secrets or activates a route.
 * Official semantics checked27Oct2026: https://openrouter.ai/docs/faq (APIbaseUSD),
 * https://openrouter.ai/docs/api/api-reference/generations/get-generation (total_cost/is_byok),
 * RFC 2104 HMAC-SHA256 (verified in SQL by app._ai_spend_hmac_sha256 over built-in sha256, migration 0651).
 * No invoice/tax/BYOK-cost claim. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,createHmac} from 'node:crypto';
import type {ResolvedAiConfig} from './types';
import {readOpenRouterInlineCharge,readOpenRouterGenerationCharge,type OpenRouterChargeEvidence} from './providers/openrouter-spend-evidence';
export type AiSpendReceiptBinding=Readonly<{tenantId:string;userId:string;runId:string;rootTaskId:string;requestDigest:string;capabilityDigest:string;configurationDigest:string}>;
export type SignedAiSpendReceipt=Readonly<{payload:string;signature:string}>;
type State={binding:AiSpendReceiptBinding;active:boolean;started:boolean;terminal:OpenRouterChargeEvidence|null;conflicting:boolean;signer:Readonly<{id:string;key:Buffer}>|null};
const carrier=new AsyncLocalStorage<State>();
export function aiSpendConfigurationDigest(cfg:ResolvedAiConfig):string{return createHash('sha256').update(JSON.stringify([cfg.provider,cfg.model,cfg.providerOptions??null])).update('\0').update(cfg.apiKey).digest('hex');}
function signingKey():State['signer']{
 const id=process.env.AI_SPEND_RECEIPT_KEY_ID,key=process.env.AI_SPEND_RECEIPT_SIGNING_KEY;
 return id&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&key&&/^[a-f0-9]{64}$/i.test(key)?Object.freeze({id,key:Buffer.from(key,'hex')}):null;
}
export function createAiSpendReceiptScope(binding:AiSpendReceiptBinding){
 const state:State={binding:Object.freeze({...binding}),active:false,started:false,terminal:null,conflicting:false,signer:signingKey()};
 return Object.freeze({async run<T>(consume:()=>Promise<T>):Promise<T>{if(state.started)throw Error('Spend receipt scope already used');state.started=true;state.active=true;try{return await carrier.run(state,consume);}finally{state.active=false;}},
  receipt():SignedAiSpendReceipt|null{
   if(state.active||state.conflicting||!state.terminal||!state.signer)return null;const b=state.binding,t=state.terminal;
   const payload=JSON.stringify(['aihr.openrouter.usd-receipt.v1',b.tenantId,b.userId,b.runId,b.rootTaskId,b.requestDigest,b.capabilityDigest,b.configurationDigest,t.generationId,t.chargeNanos,state.signer.id,t.exactCostUsd]);
   return Object.freeze({payload,signature:createHmac('sha256',state.signer.key).update(payload,'utf8').digest('hex')});
  }
 });
}
/** Called ONLY by the actual fixed-endpoint transport after complete bounded HTTP200 JSON.
 * Exact inline cost is cross-checked against the authenticated generation record's USD total_cost.
 * Explicit non-BYOK excludes unobserved upstream invoices. No new timeout/retry/background task. */
export async function observeOpenRouterSpendTerminal(raw:string,cfg:ResolvedAiConfig,signal:AbortSignal,expired:()=>boolean,fetcher:typeof fetch,read:(response:Response)=>Promise<string>):Promise<void>{
 const state=carrier.getStore();if(!state?.active||!state.signer||cfg.provider!=='openrouter'||state.binding.configurationDigest!==aiSpendConfigurationDigest(cfg))return;
 try{
  const inline=readOpenRouterInlineCharge(raw);if(inline.model!==cfg.model||signal.aborted||expired())return;
  const response=await fetcher('https://openrouter.ai/api/v1/generation?id='+encodeURIComponent(inline.generationId),{method:'GET',redirect:'error',cache:'no-store',headers:{Authorization:'Bearer '+cfg.apiKey},signal});
  const confirmed=readOpenRouterGenerationCharge(await read(response));
  if(!state.active||signal.aborted||expired()||confirmed.model!==inline.model||confirmed.generationId!==inline.generationId||confirmed.chargeNanos!==inline.chargeNanos||confirmed.exactCostUsd!==inline.exactCostUsd)return;
  if(state.terminal&&JSON.stringify(state.terminal)!==JSON.stringify(confirmed)){state.conflicting=true;state.terminal=null;return;}
  state.terminal=confirmed;
 }catch{/* Unavailable, malformed, imprecise, BYOK or mismatched evidence keeps the entire hold. */}
}
