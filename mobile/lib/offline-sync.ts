/** Offline clocking driver (owner decisions 1-7, 2026-10-28). No UI: screens call these functions. Default OFF: without
 * EXPO_PUBLIC_OFFLINE_CLOCKING==='1' every function returns `off` before any storage, native or network work, and the
 * online clock path is untouched. With it on, the server's offline capabilities must also say
 * {outcome:'offline',enabled:true,apiOrigin===config.apiUrl}; enabled:false (drain) stops new arming only.
 *
 * Connectivity test (decision 1): offline capture is chosen only when a request produced NO HTTP response
 * (NetworkUnavailableError: the fetch rejected or timed out before any status, including a token refresh). The probe is the
 * offline capabilities read made immediately before an online punch. No device-reachability API is used (none is in the
 * dependency set). A 5xx, 429 or malformed answer is an outage, never "offline", and never selects offline capture.
 *
 * Order (decision 1): with saved claims, upload them first, strictly in order, one at a time; online clocking stays paused
 * (the journal refuses an online start while any exchange exists) until every claim has a terminal receipt or the
 * employee removed it as undeliverable; then close the context and re-arm. Sync is foreground-only (decision 6): call
 * syncOffline on foreground (subscribeOfflineForeground) and on manual retry; backoff honours 429 retry-after; at most 64
 * upload attempts per rolling hour per account on this device (the server's own allowance is the authority). */
import {AppState} from 'react-native';
import {getRandomBytes,randomUUID} from 'expo-crypto';
import {assertAuthGeneration,authGeneration} from './auth';
import {config,offlineClockingBuild} from './config';
import {SignInRequiredError,SessionChangedError,UnavailableError,isNoConnectivity} from './errors';
import {OFFLINE_NOTHING_ISSUED,type OfflineExchangeView,type OfflineClaimView} from './signed-clock-journal';
import {OfflineServerAnswer} from './offline-clock-ports';
import {base64url} from './offline-sync-hash';
import {clearOfflineAnchor,writeOfflineAnchor} from './offline-anchor';
import type {openOwnedSignedClock} from './signed-clock';
type Controller=Awaited<ReturnType<typeof openOwnedSignedClock>>;
export type OfflineSyncState=
 |{state:'off';reason:'build'|'unavailable'|'draining'|'refused'|'origin_mismatch';code?:string}
 |{state:'ready';contextId:string;expiresAt:number;permitsRemaining:number}
 |{state:'idle'}
 |{state:'offline'}
 |{state:'waiting';retryAt:number;code?:string}
 |{state:'blocked';reason:'other_employment'|'needs_attention'|'closing'|'pending_online'|'not_signed'|'held';code?:string};
export type PunchRoute={route:'online'}|{route:'offline';contextId:string}|{route:'blocked';reason:string};
const HOUR=3600000,BUDGET=64,BASE_BACKOFF=30000,MAX_BACKOFF=1800000,SLOW=900000;
const pacing=new Map<string,{failures:number;retryAt:number;attempts:number[]}>();
function pace(c:Controller){const key=JSON.stringify([c.identity.namespace,c.identity.actorId,c.identity.employmentId]);let value=pacing.get(key);if(!value){value={failures:0,retryAt:0,attempts:[]};pacing.set(key,value);}return value;}
function defer(c:Controller,kind:'backoff'|'slow',retryAfterSeconds?:number,code?:string):OfflineSyncState{
 const p=pace(c);p.failures+=1;
 const delay=Math.max(kind==='slow'?SLOW:Math.min(MAX_BACKOFF,BASE_BACKOFF*2**Math.min(p.failures-1,6)),(retryAfterSeconds??0)*1000);
 p.retryAt=Date.now()+delay;return {state:'waiting',retryAt:p.retryAt,...(code?{code}:{})};
}
/** One upload attempt reserved against the rolling hourly budget; false when it is spent. */
function spend(c:Controller){
 const p=pace(c),now=Date.now();p.attempts=p.attempts.filter(at=>now-at<HOUR);
 if(p.attempts.length>=BUDGET){p.retryAt=p.attempts[0]+HOUR;return false;}
 p.attempts.push(now);return true;
}
const nonce=()=>base64url(getRandomBytes(32));
function owner(){const generation=authGeneration();return ()=>assertAuthGeneration(generation);}
/** Owner decision 1: keep a context ready while online and idle. Never arms while drain, another exchange, or any online
 * pending work exists. The anchor is saved before the reservation; a refusal proving nothing was issued drops both. */
export async function armOffline(c:Controller):Promise<OfflineSyncState>{
 const o=c.offline;if(!offlineClockingBuild||!o)return {state:'off',reason:'build'};
 const check=owner(),id=c.identity;
 let view=await o.claims();
 if(view.exchange&&!view.exchange.own)return {state:'blocked',reason:'other_employment'};
 if(view.exchange?.phase==='closing')return {state:'blocked',reason:'closing'};
 if(view.exchange?.phase==='context_ready')return ready(view);
 const caps=await o.capabilities();
 if(caps.outcome!=='offline')return {state:'off',reason:'unavailable',code:caps.code};
 if(caps.apiOrigin!==config.apiUrl)return {state:'off',reason:'origin_mismatch'};
 let requestId:string;
 if(view.exchange?.phase==='context_requested'){
  // Resume an unanswered reservation with its original request (exact recovery), even while draining.
  const saved=await c.status();if(saved.status!=='offline_pending')return {state:'blocked',reason:'pending_online'};requestId=saved.requestId;
 }else{
  if(!caps.enabled)return {state:'off',reason:'draining'};
  if((await c.status()).status!=='empty')return {state:'blocked',reason:'pending_online'};
  const {key}=await c.key(),target=await o.target();
  const binding={scope:{apiOrigin:key.apiOrigin,installationId:key.installationId,tenantId:key.tenantId,companyId:caps.companyId,actorId:id.actorId,
   employmentId:id.employmentId,appInstallationId:id.appInstallationId,deviceKeyId:key.keyId},
   request:{requestId:randomUUID(),requestNonce:nonce(),appInstallationId:id.appInstallationId,keyId:key.keyId},target};
  await writeOfflineAnchor({version:1,namespace:id.namespace,apiOrigin:id.apiOrigin,actorId:id.actorId,employmentId:id.employmentId,companyId:caps.companyId,platform:c.platform as 'ios'|'android'},check);
  await o.reserve(binding);requestId=binding.request.requestId;
 }
 try{await o.prepare(requestId);}
 catch(error){
  if(error instanceof OfflineServerAnswer&&error.answer.outcome==='refused'&&(OFFLINE_NOTHING_ISSUED as readonly string[]).includes(error.answer.code)){
   await o.abandon(requestId,error.answer.code);await clearOfflineAnchor(id,check);return {state:'off',reason:'refused',code:error.answer.code};
  }
  if(error instanceof OfflineServerAnswer)return defer(c,error.answer.outcome==='refused'?'slow':'backoff',undefined,error.answer.code);
  throw error;
 }
 view=await o.claims();return ready(view);
}
function ready(view:OfflineExchangeView):OfflineSyncState{
 const e=view.exchange;
 return e&&e.phase==='context_ready'&&e.contextId&&e.expiresAt!==null&&e.permitsRemaining!==null?{state:'ready',contextId:e.contextId,expiresAt:e.expiresAt,permitsRemaining:e.permitsRemaining}:{state:'idle'};
}
async function settled(c:Controller,rearm:boolean):Promise<OfflineSyncState>{
 await clearOfflineAnchor(c.identity,owner());pace(c).failures=0;
 return rearm?armOffline(c):{state:'idle'};
}
/** Upload saved claims first, in order, then close and re-arm. `manual` skips the backoff wait (never the budget). */
export async function syncOffline(c:Controller,options:{manual?:boolean;rearm?:boolean}={}):Promise<OfflineSyncState>{
 const o=c.offline;if(!offlineClockingBuild||!o)return {state:'off',reason:'build'};
 const p=pace(c);if(!options.manual&&Date.now()<p.retryAt)return {state:'waiting',retryAt:p.retryAt};
 let view=await o.claims();if(!view.exchange)return options.rearm===false?{state:'idle'}:armOffline(c);
 if(!view.exchange.own)return {state:'blocked',reason:'other_employment'};
 let caps:Awaited<ReturnType<typeof o.capabilities>>;
 try{caps=await o.capabilities();}catch(error){if(isNoConnectivity(error))return {state:'offline'};throw error;}
 if(caps.outcome!=='offline')return {state:'off',reason:'unavailable',code:caps.code};
 if(caps.apiOrigin!==config.apiUrl)return {state:'off',reason:'origin_mismatch'};
 const id=c.identity;
 // The same employee, verified online: (re)write this session's anchor so an offline cold start can open the queue.
 await writeOfflineAnchor({version:1,namespace:id.namespace,apiOrigin:id.apiOrigin,actorId:id.actorId,employmentId:id.employmentId,companyId:caps.companyId,platform:c.platform as 'ios'|'android'},owner());
 const rearm=caps.enabled&&options.rearm!==false;let freshTokenRetried=false;
 for(let guard=0;guard<80;guard++){
  view=await o.claims();const e=view.exchange;
  if(!e)return settled(c,rearm);
  if(e.phase==='context_requested')return rearm?armOffline(c):{state:'blocked',reason:'pending_online'};
  // A ready context with no claims is the armed state itself: nothing to send, nothing to close.
  if(e.phase==='context_ready'&&e.claimCount===0)return ready(view);
  const live=view.claims.filter(claim=>claim.contextId===e.contextId);
  if(e.phase==='closing'||live.every(claim=>claim.state!=='waiting')){
   if(live.some(claim=>claim.state==='undeliverable'))return {state:'blocked',reason:'needs_attention'};
   let closed:Awaited<ReturnType<typeof o.close>>;
   try{closed=await o.close(randomUUID());}catch(error){return transport(c,error);}
   if(closed.status==='closed')return settled(c,rearm);
   if(closed.status==='reopened')continue;
   if(closed.status==='retry')return defer(c,'backoff',undefined,closed.code);
   return {state:'blocked',reason:'held',code:closed.reason};
  }
  const next=live.find(claim=>claim.state==='waiting')!;
  const signed=await o.sign(next.requestId,e.contextId!);
  if(signed.status!=='proof_ready')return signed.reason==='native_unavailable'?defer(c,'backoff',undefined,signed.reason):{state:'blocked',reason:'not_signed',code:signed.reason};
  if(!spend(c))return {state:'waiting',retryAt:p.retryAt,code:'budget'};
  let result:Awaited<ReturnType<typeof o.uploadNext>>;
  try{result=await o.uploadNext();}catch(error){return transport(c,error);}
  if(result.status==='processed'){p.failures=0;freshTokenRetried=false;if(result.closed)return settled(c,rearm);continue;}
  if(result.status==='idle')continue;
  if(result.status==='undeliverable')return {state:'blocked',reason:'needs_attention',code:result.reason};
  if(result.status==='not_signed')return {state:'blocked',reason:'not_signed'};
  if(result.pace==='fresh_token'&&!freshTokenRetried){freshTokenRetried=true;continue;}
  return defer(c,result.pace==='slow'?'slow':'backoff',undefined,result.code);
 }
 return defer(c,'backoff');
}
/** Keeps the queue on every transport failure; 401 propagates (the queue stays sealed for the same employee). */
function transport(c:Controller,error:unknown):OfflineSyncState{
 if(error instanceof SignInRequiredError||error instanceof SessionChangedError)throw error;
 if(isNoConnectivity(error)){defer(c,'backoff');return {state:'offline'};}
 if(error instanceof UnavailableError)return defer(c,'backoff',error.retryAfter);
 throw error;
}
/** Owner decision 1, before every online punch: the route to take. `offline` only when the probe got no HTTP response and
 * a ready context with a free permit exists; `online` once no exchange remains (a zero-claim context is handed back,
 * saved claims are uploaded first). Flag off: always `online`, with no call at all. */
export async function beforeOnlinePunch(c:Controller):Promise<PunchRoute>{
 const o=c.offline;if(!offlineClockingBuild||!o)return {route:'online'};
 let e=(await o.claims()).exchange;if(!e)return {route:'online'};
 if(!e.own)return {route:'blocked',reason:'other_employment'};
 try{await o.capabilities();}
 catch(error){
  if(!isNoConnectivity(error))throw error;
  return e.phase==='context_ready'&&e.contextId&&(e.permitsRemaining??0)>0?{route:'offline',contextId:e.contextId}:{route:'blocked',reason:'offline_unavailable'};
 }
 // An unanswered reservation is recovered first (exact retry), so it can be handed back like any unused context.
 if(e.phase==='context_requested'){await armOffline(c);e=(await o.claims()).exchange;if(!e)return {route:'online'};}
 if(e.phase==='context_ready'&&e.claimCount===0){
  const handed=await o.handback(randomUUID());
  if(handed.status==='closed'){await clearOfflineAnchor(c.identity,owner());return {route:'online'};}
  return {route:'blocked',reason:handed.status==='held'?handed.reason:handed.status};
 }
 const state=await syncOffline(c,{manual:true,rearm:false});
 if((await o.claims()).exchange===null)return {route:'online'};
 return {route:'blocked',reason:state.state==='blocked'?state.reason:state.state};
}
/** Re-arm in the background after an online punch completes (decision 1). */
export const afterOnlinePunch=(c:Controller)=>armOffline(c);
/** Offline capture of the base command the clock screen already saved (same requestId), then local signing (no
 * network). A retry of the same request keeps its original claimed time; device wall time is a report only. */
export async function captureOfflinePunch(c:Controller,requestId:string){
 const o=c.offline;if(!offlineClockingBuild||!o)throw new UnavailableError('Offline clocking is not available.');
 const view=await o.claims(),e=view.exchange;
 if(!e||!e.own||e.phase!=='context_ready'||!e.contextId)throw new UnavailableError('Offline clocking is not ready.');
 const existing=view.claims.find(claim=>claim.requestId===requestId&&claim.contextId===e.contextId);
 const snapshot=o.snapshot();if(snapshot.status!=='evidence')throw new UnavailableError('Offline clocking is not available on this device.');
 if(AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
 const captured=await o.capture({requestId,expectedContextId:e.contextId,claimedAt:existing?.claimedAt??Date.now(),eventSnapshot:snapshot.evidence});
 const proof=await o.sign(requestId,e.contextId);
 return {captured,proof};
}
/** Per-claim outcomes for the employee's own employment (decision 4). */
export async function offlineClaims(c:Controller):Promise<OfflineClaimView[]>{
 if(!offlineClockingBuild||!c.offline)return [];return (await c.offline.claims()).claims;
}
/** Decision 2: the employee's confirmed removal (the screen asks for confirmation first). */
export async function removeUndeliverable(c:Controller,requestId:string){
 if(!offlineClockingBuild||!c.offline)throw new UnavailableError('Offline clocking is not available.');
 return c.offline.removeUndeliverable(requestId);
}
/** Foreground-only retry (decision 6). Returns the unsubscribe function. */
export function subscribeOfflineForeground(run:()=>void){
 if(!offlineClockingBuild)return ()=>{};
 const subscription=AppState.addEventListener('change',state=>{if(state==='active')run();});
 return ()=>subscription.remove();
}
export type {OfflineClaimView};
