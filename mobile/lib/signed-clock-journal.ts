/** One installed-account proof owner for online proofs and the offline context exchange. Neither context preparation
 * nor a saved receipt enables or grants attendance: the server's processed receipt is the only claim outcome. */
import {z} from 'zod';
import {ClockCommand,ClockReceipt,SubmissionReceiptResponse,SubmissionAbandonResponse} from '../../lib/mobile-api/contract';
import {ClockSourceSignals,OnlineClockIntegrityData,onlineClockClientData} from '../../lib/mobile-clock-integrity';
import * as C from '../../lib/mobile-integrity-contract';
import {AndroidPlayCloudProject} from '../../lib/mobile-android-clock-policy';
import {EnrollmentScope} from './enrollment-journal';
import {ClockSigningKey} from './clock-signing-key';
import {NativeCapabilities,NativeClockSnapshot,AppleOfflineProofSnapshot,type NativeIntegrityResult} from './integrity-bridge';
import {OfflineClockContextBinding,OfflineClockContextData,offlineClockContextClientData,type OfflineClockContextVerificationResult} from '../../lib/mobile-offline-context';
import {OfflineClockClaimData,OfflineClockAppleAssertion,OfflineClockAndroidSignature,OfflineClockSignedClaim,offlineClockClaimClientData} from '../../lib/mobile-offline-clock';
import {OfflineClockReceipt} from '../../lib/mobile-offline-receipt';
import {OfflineClaimResult,OfflineCloseResult,type OfflineSyncIntegrityRefusal} from '../../lib/mobile-offline-contract';
import {OfflineClockCaptureInput,offlineClockPhotoReference,offlineWireElapsed,type OfflineClockCapturedClaim,type OfflineClockProofPorts,offlineCaptureComplete,OfflineClockExchange,validateOfflineClockExchange,
 offlineProofHeld,offlineReceiptHeld,offlineUploadReady,offlineClaimSettled,offlineReceiptMatches,type OfflineUndeliverableReason} from './offline-clock-state';
import {RequestRejectedError} from './errors';
const uuid=z.string().uuid().transform(value=>value.toLowerCase()),sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const reference=z.object({employmentId:uuid,requestId:uuid,baseDigest:sha,action:z.enum(['in','out'])}).strict();
const disposition=z.object({receipt:ClockReceipt.nullable(),abandoned:z.boolean()}).strict().refine(value=>!!value.receipt!==value.abandoned);
const active=reference.extend({phase:z.enum(['intent','prepared','proof_ready','sent']),key:ClockSigningKey,
 evidence:OnlineClockIntegrityData.shape.evidence,project:AndroidPlayCloudProject.nullable(),
 context:OnlineClockIntegrityData.nullable(),proof:z.string().min(4).max(10924).nullable()}).strict();
const settled=reference.extend({phase:z.literal('settled'),disposition}).strict();
const pending=z.union([active,settled]);
const legacySnapshot=z.object({version:z.literal(1),revision:z.number().int().positive().max(999999999999999),scope:EnrollmentScope,pending:pending.nullable()}).strict();
/** Outcomes of the last closed context that had receipts, kept only for the employee's own view (owner decision 4);
 * replaced by the next close that has receipts. Absent until then, so online-only snapshots keep their exact bytes. */
const recentOutcome=z.object({employmentId:uuid,action:z.enum(['in','out']),claimedAt:z.number().int().positive().max(8640000000000000),receipt:OfflineClockReceipt}).strict();
const snapshot=legacySnapshot.extend({version:z.literal(2),offline:OfflineClockExchange.nullable(),recent:z.array(recentOutcome).min(1).max(32).optional()}).refine(value=>!value.pending||!value.offline);
export type SignedClockSnapshot=z.infer<typeof snapshot>;
export type SignedClockReference=z.infer<typeof reference>;
export type SignedClockPending=z.infer<typeof active>;
const baseSchema=z.object({digest:sha,command:ClockCommand,photo:OnlineClockIntegrityData.shape.command.shape.photo,source:ClockSourceSignals}).strict();
export type SignedClockBase=z.infer<typeof baseSchema>;
export class SignedClockConflict extends Error{constructor(){super('Review the saved signed clock attempt');this.name='SignedClockConflict';}}
export type SignedClockUnavailableReason='unavailable'|'configuration'|'storage'|'registration_required'|'native_unavailable'|'unsupported'|'saved_command'|'expired';
export class SignedClockUnavailable extends Error{constructor(readonly reason:SignedClockUnavailableReason='unavailable'){super('Signed clocking unavailable');this.name='SignedClockUnavailable';}}
const refusal=C.IntegrityRefused.omit({outcome:true});
export type SignedClockStatus={status:'empty'}|{status:'other_pending'}|
 {status:'offline_pending';requestId:string;phase:OfflineClockExchange['phase']}|
 {status:'pending';requestId:string;action:'in'|'out';phase:z.infer<typeof pending>['phase'];reason?:string;refusal?:z.infer<typeof refusal>}|
 {status:'accepted';receipt:z.infer<typeof ClockReceipt>}|{status:'abandoned'};
/** Context-request refusals that prove nothing was issued for this request: the reservation may be dropped (E1 -> none).
 * binding_conflict, time_unavailable and every `unavailable` answer keep the reservation for an exact retry. */
export const OFFLINE_NOTHING_ISSUED=['offline_pending','online_pending','offline_disabled','device_required','context_closed','key_unavailable'] as const;
/** Claim-upload refusals that can never succeed for this claim (owner decision 2); a 400 is bad_request. */
const UNDELIVERABLE=['key_unavailable','context_closed','context_unavailable','binding_conflict','invalid_proof','attachment_mismatch','invalid_claim'] as const;
/** A fresh Play token is the remedy: retry now with a new token (the next attempt always requests one). */
const FRESH_TOKEN:readonly string[]=['stale_token','request_mismatch','invalid_token','token_missing'];
export type OfflineUploadResult={status:'idle'}|{status:'not_signed';requestId:string}|
 {status:'processed';requestId:string;receipt:OfflineClockReceipt;closed:boolean}|{status:'undeliverable';requestId:string;reason:OfflineUndeliverableReason}|
 {status:'retry';requestId:string;code:string;pace:'fresh_token'|'backoff'|'slow';integrityReason?:z.infer<typeof OfflineSyncIntegrityRefusal>|string};
export type OfflineCloseOutcome={status:'closed'}|{status:'reopened'}|{status:'retry';code:string}|{status:'held';reason:string};
type ClaimBase={requestId:string;contextId:string;sequence:number;action:'in'|'out';claimedAt:number};
/** What the employee sees per claim (owner decision 4): only the server outcome, or that it is waiting or cannot be sent. */
export type OfflineClaimView=ClaimBase&({state:'waiting'}|{state:'recorded';effectiveAt:number;receivedAt:number}|
 {state:'held';reason:string;receivedAt:number}|{state:'not_recorded';reason:string;receivedAt:number}|{state:'undeliverable';reason:OfflineUndeliverableReason});
export type OfflineExchangeView={exchange:null|{phase:OfflineClockExchange['phase'];own:boolean;contextId:string|null;expiresAt:number|null;permitsRemaining:number|null;claimCount:number|null};claims:OfflineClaimView[]};
export type OfflineSignResult={status:'proof_ready';requestId:string;acceptance:'not_granted'}|{status:'pending';requestId:string;reason:'earlier_claim'|'native_unavailable'|'unsupported'|'invalid_evidence'|'recovery_required'};
export type SignedClockPorts={
 assertCurrent():void;read():Promise<SignedClockSnapshot|null>;commit(value:SignedClockSnapshot):Promise<void>;
 base(employmentId:string,requestId:string):Promise<SignedClockBase>;
 key():Promise<{key:ClockSigningKey;capability:z.infer<typeof NativeCapabilities>}>;
 capabilities():Promise<unknown>;
 begin(pending:SignedClockPending,input:unknown):Promise<unknown>;
 sign(key:ClockSigningKey,context:OnlineClockIntegrityData):Promise<NativeIntegrityResult<string>>;
 play(project:string,context:OnlineClockIntegrityData):Promise<NativeIntegrityResult<string>>;
 complete(pending:SignedClockPending,input:unknown,token?:string):Promise<unknown>;
 receipt(employmentId:string,requestId:string):Promise<unknown>;
 abandon(employmentId:string,requestId:string):Promise<unknown>;
 resolveBase(reference:SignedClockReference):Promise<void>;
 offline?:{
  snapshot():NativeIntegrityResult<NativeClockSnapshot>;
  request(binding:OfflineClockContextBinding):Promise<string>;
  verify(raw:string,binding:OfflineClockContextBinding):Promise<OfflineClockContextVerificationResult>;
  signing?:OfflineClockProofPorts;
  capture?:{
   capabilities():NativeIntegrityResult<z.infer<typeof NativeCapabilities>>;
   digest(canonical:string):Promise<string>;
   retainPhoto(requestId:string,expected:NonNullable<OfflineClockClaimData['command']['photo']>):Promise<string>;
   releaseBase(reference:SignedClockReference):Promise<void>;
  };
  /** Transport. upload sends the exact saved claim (+ its retained photo; Android adds a fresh payload-bound Play token)
   * and returns the unparsed OfflineClaimResult; close returns the unparsed OfflineCloseResult. deletePhoto ends local
   * custody of a settled claim's photo and must be idempotent. */
  sync?:{
   upload(signed:OfflineClockSignedClaim,entry:{requestId:string;digest:string}):Promise<unknown>;
   close(request:{contextId:string;closeRequestId:string;consumedThrough:number}):Promise<unknown>;
   deletePhoto(requestId:string):Promise<void>;
  };
 };

};
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
export function parseSignedClockSnapshot(raw:unknown,scope:EnrollmentScope):SignedClockSnapshot{
 try{
  const parsed=z.union([legacySnapshot,snapshot]).parse(raw);
  const value=parsed.version===1?{...parsed,version:2 as const,offline:null}:parsed;
  if(!same(value.scope,EnrollmentScope.parse(scope)))throw new Error();
  if(value.offline)validateOfflineClockExchange(value.offline,scope);
  const p=value.pending;if(p&&p.phase!=='settled'){
   if(p.key.apiOrigin!==scope.apiOrigin||p.key.actorId!==scope.actorId||p.key.appInstallationId!==scope.appInstallationId||p.evidence.platform!==p.key.platform)throw new Error();
   if(p.key.platform==='ios'?p.project!==null:p.project===null)throw new Error();
   if(p.phase==='intent'?(p.context!==null||p.proof!==null):!p.context)throw new Error();
   if((p.phase==='proof_ready'||p.phase==='sent')!==!!p.proof)throw new Error();
   if(p.proof&&!(p.key.platform==='ios'?C.IntegrityClockProof.shape.assertion:C.IntegrityAndroidClockProof.shape.signature).safeParse(p.proof).success)throw new Error();
   if(p.context){const c=p.context;if(c.scope.apiOrigin!==scope.apiOrigin||c.scope.actorId!==scope.actorId||c.scope.employmentId!==p.employmentId||c.scope.deviceKeyId!==p.key.keyId||c.scope.tenantId!==p.key.tenantId||c.scope.installationId!==p.key.installationId||c.command.requestId!==p.requestId||c.command.action!==p.action||!same(c.evidence,p.evidence))throw new Error();}
  }
  if(p?.phase==='settled'&&p.disposition.receipt&&p.disposition.receipt.direction!==p.action)throw new Error();return value;
 }catch{throw new SignedClockUnavailable('storage');}
}
const queues=new Map<string,Promise<void>>();
function exclusive<T>(key:string,work:()=>Promise<T>){const next=(queues.get(key)??Promise.resolve()).then(work),tail=next.then(()=>{},()=>{});queues.set(key,tail);return next.finally(()=>{if(queues.get(key)===tail)queues.delete(key);});}
export function createSignedClockJournal(rawScope:EnrollmentScope,ports:SignedClockPorts){
 const scope=EnrollmentScope.parse(rawScope),queue=JSON.stringify(['signed-clock-v1',scope]);
 async function owned<T>(work:()=>Promise<T>){ports.assertCurrent();try{const value=await work();ports.assertCurrent();return value;}catch(error){ports.assertCurrent();throw error;}}
 async function read():Promise<SignedClockSnapshot>{const raw=await owned(()=>ports.read());return raw?parseSignedClockSnapshot(raw,scope):{version:2 as const,revision:0,scope,pending:null,offline:null};}
 type State=Awaited<ReturnType<typeof read>>;
 async function save(s:State,p:SignedClockSnapshot['pending']){const next=parseSignedClockSnapshot({...s,version:2,revision:s.revision+1,scope,pending:p},scope);await owned(()=>ports.commit(structuredClone(next)));return next;}
 function status(s:State,selected:string,reason?:string,refused?:z.infer<typeof C.IntegrityRefused>):SignedClockStatus{
  if(s.offline)return s.offline.binding.scope.employmentId!==selected?{status:'other_pending'}:{status:'offline_pending',requestId:s.offline.binding.request.requestId,phase:s.offline.phase};
  const p=s.pending;return !p?{status:'empty'}:p.employmentId!==selected?{status:'other_pending'}:{status:'pending',requestId:p.requestId,action:p.action,phase:p.phase,...(reason?{reason}:{}),...(refused?{refusal:refusal.parse(refused)}:{})};
 }
 async function base(p:SignedClockReference){const value=baseSchema.parse(await owned(()=>ports.base(p.employmentId,p.requestId)));if(value.digest!==p.baseDigest||value.command.requestId!==p.requestId||value.command.action!==p.action)throw new SignedClockConflict();return value;}
 function intent(p:SignedClockPending,b:SignedClockBase){const {deviceToken,...command}=b.command;return {appInstallationId:scope.appInstallationId,keyId:p.key.keyId,...(deviceToken?{deviceToken}:{}),command,evidence:p.evidence};}
 function checkedDisposition(value:unknown,p:SignedClockReference,abandon=false){const result=(abandon?SubmissionAbandonResponse:SubmissionReceiptResponse).parse(value);if(result.kind!=='clock'||result.requestId!==p.requestId||result.receipt&&result.receipt.direction!==p.action)throw new SignedClockConflict();return result.receipt?{receipt:result.receipt,abandoned:false}:result.abandoned?{receipt:null,abandoned:true}:null;}
 async function finish(s:State,p:SignedClockReference,d:z.infer<typeof disposition>):Promise<SignedClockStatus>{
  const ref=reference.parse({employmentId:p.employmentId,requestId:p.requestId,baseDigest:p.baseDigest,action:p.action});
  const confirmed=await save(s,{...ref,phase:'settled',disposition:d});
  await owned(()=>ports.resolveBase(ref));await save(confirmed,null);
  return d.receipt?{status:'accepted',receipt:d.receipt}:{status:'abandoned'};
 }
 async function observe(s:State,p:z.infer<typeof pending>){const d=checkedDisposition(await owned(()=>ports.receipt(p.employmentId,p.requestId)),p);return d?finish(s,p,d):null;}
 async function capabilities(platform:'ios'|'android'){
  const value=C.IntegrityClockCapabilities.parse(await owned(()=>ports.capabilities()));
  if(value.outcome!=='capabilities'||value.platform!==platform)throw new SignedClockUnavailable('configuration');return value;
 }
 async function saveOffline(s:State,offline:OfflineClockExchange){
  const next=parseSignedClockSnapshot({...s,version:2,revision:s.revision+1,offline},scope);
  await owned(()=>ports.commit(structuredClone(next)));return next;
 }
 function offlinePorts(){if(!ports.offline)throw new SignedClockUnavailable('configuration');return ports.offline;}
 function signingPorts(){const value=offlinePorts().signing;if(!value)throw new SignedClockUnavailable('configuration');return value;}
 function capturePorts(){const value=offlinePorts().capture;if(!value)throw new SignedClockUnavailable('configuration');return value;}
 function localSnapshot(){const result=offlinePorts().snapshot();ports.assertCurrent();if(result.status!=='evidence')throw new SignedClockUnavailable(result.status==='unsupported'?'unsupported':'native_unavailable');return NativeClockSnapshot.parse(result.evidence);}
 async function verifyOffline(raw:string,binding:OfflineClockContextBinding){
  const result=await owned(()=>offlinePorts().verify(raw,structuredClone(binding)));
  if(result.outcome!=='signature_valid'||result.authorization!=='not_granted'||!sha.safeParse(result.digest).success)throw new SignedClockUnavailable('configuration');
  return {...result,context:OfflineClockContextData.parse(result.context)};
 }
 async function verifyCapturedDigests(p:Extract<OfflineClockExchange,{phase:'context_ready'}>){
  for(const entry of p.claims){const digest=sha.parse(await owned(()=>capturePorts().digest(offlineClockClaimClientData(entry.claim))));if(digest!==entry.digest)throw new SignedClockUnavailable('storage');}
 }
 async function completeOfflineCapture(s:State,p:Extract<OfflineClockExchange,{phase:'context_ready'}>,index:number){
  let state=s,exchange=p,entry=p.claims[index];
  async function transition(phase:OfflineClockCapturedClaim['phase']){
   entry={...entry,phase};exchange={...exchange,claims:exchange.claims.map((value,at)=>at===index?entry:value)};
   state=await saveOffline(state,exchange);
  }
  if(entry.phase==='capture_requested'){
   const photo=entry.claim.command.photo;
   if(photo){const reference=await owned(()=>capturePorts().retainPhoto(entry.claim.command.requestId,structuredClone(photo)));if(reference!==entry.photoReference)throw new SignedClockConflict();}
   await transition('photo_retained');
  }
  if(entry.phase==='photo_retained'){
   await owned(()=>capturePorts().releaseBase({employmentId:entry.claim.scope.employmentId,requestId:entry.claim.command.requestId,baseDigest:entry.baseDigest,action:entry.claim.command.action}));
   await transition('captured');
  }
  return {status:'captured' as const,requestId:entry.claim.command.requestId,sequence:entry.claim.chain.sequence,acceptance:'not_granted' as const};
 }
 type Ready=Exclude<OfflineClockExchange,{phase:'context_requested'}>;
 function syncPorts(){const value=offlinePorts().sync;if(!value)throw new SignedClockUnavailable('configuration');return value;}
 const contextOf=(p:Ready)=>OfflineClockContextData.parse((JSON.parse(p.rawContext) as {context:unknown}).context);
 const allReceived=(p:Ready)=>p.claims.length>0&&p.claims.length===contextOf(p).permits.length&&p.claims.every(entry=>offlineReceiptHeld(entry.phase));
 function withClaim(p:Ready,index:number,entry:OfflineClockCapturedClaim):Ready{return {...p,claims:p.claims.map((value,at)=>at===index?entry:value)};}
 /** C6 -> C7: the receipt is committed before the photo is deleted; a restart deletes again (idempotent), then commits C7. */
 async function settleReceipts(initial:State){
  let s=initial;
  for(;;){
   const p=s.offline;if(!p||p.phase==='context_requested')return s;
   const index=p.claims.findIndex(entry=>entry.phase==='receipt_saved');if(index<0)return s;
   const entry=p.claims[index];if(entry.photoReference)await owned(()=>syncPorts().deletePhoto(entry.claim.command.requestId));
   s=await saveOffline(s,withClaim(p,index,{...entry,phase:'photo_deleted'}));
  }
 }
 /** E4: every claim is settled (receipt or confirmed removal). Photos go first, then offline:null with the receipts kept
  * for the employee's view. A crash between leaves the exchange; the retry deletes again (idempotent) and commits. */
 async function clearExchange(s:State){
  const p=s.offline;if(!p||p.phase==='context_requested'||!p.claims.every(offlineClaimSettled))throw new SignedClockConflict();
  for(const entry of p.claims)if(entry.photoReference)await owned(()=>syncPorts().deletePhoto(entry.claim.command.requestId));
  const recent=p.claims.flatMap(entry=>entry.receipt?[{employmentId:entry.claim.scope.employmentId,action:entry.claim.command.action,claimedAt:entry.claim.time.claimedAt,receipt:entry.receipt}]:[]);
  const next=parseSignedClockSnapshot({...s,version:2,revision:s.revision+1,offline:null,recent:recent.length?recent:s.recent},scope);
  await owned(()=>ports.commit(structuredClone(next)));return next;
 }
 async function markUndeliverable(s:State,p:Ready,index:number,reason:OfflineUndeliverableReason):Promise<OfflineUploadResult>{
  const entry=p.claims[index];await saveOffline(s,withClaim(p,index,{...entry,undeliverable:{reason,dismissed:false}}));
  return {status:'undeliverable',requestId:entry.claim.command.requestId,reason};
 }
 function receiptView(r:OfflineClockReceipt){
  return r.outcome==='accepted'?{state:'recorded' as const,effectiveAt:r.effectiveAt!,receivedAt:r.receivedAt}:
   r.outcome==='needs_review'?{state:'held' as const,reason:r.reason,receivedAt:r.receivedAt}:{state:'not_recorded' as const,reason:r.reason,receivedAt:r.receivedAt};
 }
 /** Own employment only: another profile sees that an exchange exists, never its claims. */
 function offlineView(s:State,selected:string):OfflineExchangeView{
  const p=s.offline,own=!!p&&p.binding.scope.employmentId===selected,claims:OfflineClaimView[]=[];
  for(const item of s.recent??[])if(item.employmentId===selected)claims.push({requestId:item.receipt.requestId,contextId:item.receipt.contextId,sequence:item.receipt.sequence,action:item.action,claimedAt:item.claimedAt,...receiptView(item.receipt)});
  let blocked=false;
  if(p&&own&&p.phase!=='context_requested')for(const entry of p.claims){
   const c=entry.claim,base={requestId:c.command.requestId,contextId:c.context.id,sequence:c.chain.sequence,action:c.command.action,claimedAt:c.time.claimedAt};
   const reason:OfflineUndeliverableReason|null=entry.undeliverable?.reason??(blocked?'earlier_undeliverable':null);blocked=blocked||!!entry.undeliverable;
   if(entry.receipt)claims.push({...base,...receiptView(entry.receipt)});
   else if(!entry.undeliverable?.dismissed)claims.push(reason?{...base,state:'undeliverable',reason}:{...base,state:'waiting'});
  }
  const context=p&&own&&p.phase!=='context_requested'?contextOf(p):null;
  return {exchange:p?{phase:p.phase,own,contextId:context?.id??null,expiresAt:context?.expiresAt??null,
   permitsRemaining:context&&p.phase!=='context_requested'?context.permits.length-p.claims.length:null,
   claimCount:own&&p.phase!=='context_requested'?p.claims.length:null}:null,claims};
 }
 async function close(requestId:string,unusedOnly:boolean):Promise<OfflineCloseOutcome>{
  let s=await settleReceipts(await read());let p=s.offline;
  if(!p)return {status:'closed'};
  if(p.phase==='context_requested')return {status:'held',reason:'not_ready'};
  if(unusedOnly&&p.claims.length>0)return {status:'held',reason:'claims'};
  if(p.phase==='context_ready'){
   // Never close while a deliverable claim lacks its receipt (C1-C5), or while an undeliverable one awaits the employee.
   if(!p.claims.every(offlineClaimSettled))return {status:'held',reason:'claims'};
   // The last permit's receipt already closed the context on the server (exhausted): clear locally without a POST.
   if(allReceived(p)){await clearExchange(s);return {status:'closed'};}
   s=await saveOffline(s,{...p,phase:'closing',close:{requestId,consumedThrough:p.claims.filter(entry=>offlineReceiptHeld(entry.phase)).length}});p=s.offline!;
  }
  if(p.phase!=='closing')throw new SignedClockConflict();
  const contextId=contextOf(p).id,request={contextId,closeRequestId:p.close.requestId,consumedThrough:p.close.consumedThrough};
  const result=OfflineCloseResult.parse(await owned(()=>syncPorts().close(structuredClone(request))));
  if(result.outcome==='closed'){
   if(result.contextId!==contextId||result.consumedThrough!==request.consumedThrough)throw new SignedClockConflict();
   await clearExchange(s);return {status:'closed'};
  }
  if(result.outcome==='unavailable')return {status:'retry',code:result.code};
  if(result.code==='cursor_mismatch'){
   // The server consumed a claim this phone has no receipt for: reopen, requeue every unreceived claim (an exact retry
   // returns its terminal receipt), upload, then close again.
   const {close:_saved,...rest}=p;void _saved;
   await saveOffline(s,{...rest,phase:'context_ready',claims:p.claims.map(entry=>offlineReceiptHeld(entry.phase)?entry:{...entry,undeliverable:null})});
   return {status:'reopened'};
  }
  // Closed by the server (exhausted, revoked key, unreadable context): every local claim is already settled here.
  if(result.code==='context_closed'||result.code==='key_unavailable'||result.code==='context_unavailable'){await clearExchange(s);return {status:'closed'};}
  return {status:'held',reason:result.code};
 }
 return {
  /** One claim per call, inside the serialized owner: the lowest claim without a receipt, only once its proof is durable
   * and its native custody released. It never signs; a retry resends the identical saved claim JSON and photo bytes. */
  uploadNextOffline:()=>exclusive(queue,async():Promise<OfflineUploadResult>=>{
   const s=await settleReceipts(await read()),p=s.offline;
   if(!p||p.phase!=='context_ready'||s.pending)return {status:'idle'};
   if(allReceived(p)){await clearExchange(s);return {status:'idle'};}
   const index=p.claims.findIndex(entry=>!offlineReceiptHeld(entry.phase));if(index<0)return {status:'idle'};
   const entry=p.claims[index],requestId=entry.claim.command.requestId;
   if(entry.undeliverable)return {status:'undeliverable',requestId,reason:entry.undeliverable.reason};
   if(!offlineUploadReady(entry))return {status:'not_signed',requestId};
   await verifyCapturedDigests(p);
   const signed=OfflineClockSignedClaim.parse({claim:entry.claim,proof:p.key.platform==='ios'?{platform:'ios',assertion:entry.proof}:{platform:'android',signature:entry.proof}});
   let raw:unknown;
   try{raw=await owned(()=>syncPorts().upload(structuredClone(signed),{requestId,digest:entry.digest}));}
   catch(error){if(error instanceof RequestRejectedError&&error.status===400)return markUndeliverable(s,p,index,'bad_request');throw error;}
   const result=OfflineClaimResult.parse(raw);
   if(result.outcome==='processed'){
    const receipt=result.receipt;if(!offlineReceiptMatches(receipt,entry))throw new SignedClockConflict();
    const saved=await settleReceipts(await saveOffline(s,withClaim(p,index,{...entry,phase:'receipt_saved',receipt})));
    const after=saved.offline,closed=!!after&&after.phase==='context_ready'&&allReceived(after);
    if(closed)await clearExchange(saved);
    return {status:'processed',requestId,receipt,closed};
   }
   if(result.outcome==='unavailable')return {status:'retry',requestId,code:result.code,pace:'backoff',...(result.integrityReason?{integrityReason:result.integrityReason}:{})};
   const code=result.code;
   if((UNDELIVERABLE as readonly string[]).includes(code))return markUndeliverable(s,p,index,code as OfflineUndeliverableReason);
   if(code==='sync_integrity')return {status:'retry',requestId,code,pace:FRESH_TOKEN.includes(result.integrityReason??'')?'fresh_token':'slow',...(result.integrityReason?{integrityReason:result.integrityReason}:{})};
   // chain_conflict: nothing was consumed; the lowest unreceived claim is resent after backoff. Other refusals: slow retry.
   return {status:'retry',requestId,code,pace:code==='chain_conflict'?'backoff':'slow'};
  }),
  /** E2/E3 -> E4. The close request is saved before its POST; a retry resends the same closeRequestId/consumedThrough. */
  closeOffline:(closeRequestId:string)=>exclusive(queue,()=>close(uuid.parse(closeRequestId),false)),
  /** Owner decision 1: before an online punch, a ready context with zero claims is closed (consumedThrough 0). */
  handbackUnusedContext:(closeRequestId:string)=>exclusive(queue,()=>close(uuid.parse(closeRequestId),true)),
  /** E1 -> none, only for a refusal proving no context was issued for this exact request. */
  abandonReservation:(requestId:string,code:string)=>exclusive(queue,async()=>{
   const id=uuid.parse(requestId),s=await read(),p=s.offline;
   if(!p||p.phase!=='context_requested'||p.binding.request.requestId!==id||!(OFFLINE_NOTHING_ISSUED as readonly string[]).includes(code))throw new SignedClockConflict();
   const next=parseSignedClockSnapshot({...s,version:2,revision:s.revision+1,offline:null},scope);await owned(()=>ports.commit(structuredClone(next)));
   return status(next,p.binding.scope.employmentId);
  }),
  /** Owner decision 2: the employee's confirmed removal of a claim that can never be delivered. The removal is committed
   * before its photo is deleted; the claim is never sent. */
  removeUndeliverable:(requestId:string)=>exclusive(queue,async()=>{
   const id=uuid.parse(requestId);let s=await read();const p=s.offline;
   if(!p||p.phase!=='context_ready')throw new SignedClockConflict();
   const index=p.claims.findIndex(entry=>entry.claim.command.requestId===id),entry=p.claims[index];
   if(!entry||entry.receipt)throw new SignedClockConflict();
   const reason=entry.undeliverable?.reason??(p.claims.slice(0,index).some(value=>value.undeliverable)?'earlier_undeliverable' as const:null);
   if(!reason)throw new SignedClockConflict();
   if(!entry.undeliverable?.dismissed)s=await saveOffline(s,withClaim(p,index,{...entry,undeliverable:{reason,dismissed:true}}));
   if(entry.photoReference)await owned(()=>syncPorts().deletePhoto(id));
   return offlineView(s,entry.claim.scope.employmentId);
  }),
  /** Read-only view for the employee's own employment. */
  offlineClaims:(employmentId:string)=>exclusive(queue,async()=>offlineView(await read(),uuid.parse(employmentId))),
  signOffline:(requestId:string,expectedContextId:string)=>exclusive(queue,async():Promise<OfflineSignResult>=>{
   const id=uuid.parse(requestId),contextId=uuid.parse(expectedContextId);let s=await read();const initial=s.offline,signer=signingPorts();
   if(!initial||initial.phase!=='context_ready'||s.pending)throw new SignedClockConflict();
   const context=OfflineClockContextData.parse((JSON.parse(initial.rawContext) as {context:unknown}).context);
   if(context.id!==contextId)throw new SignedClockConflict();
   const index=initial.claims.findIndex(entry=>entry.claim.command.requestId===id);if(index<0)throw new SignedClockConflict();
   if(initial.claims.slice(0,index).some(entry=>!offlineProofHeld(entry.phase)||!entry.nativeReleased))return {status:'pending',requestId:id,reason:'earlier_claim'};
   await verifyCapturedDigests(initial);let p=initial,entry=initial.claims[index];
   if(!offlineCaptureComplete(entry.phase))throw new SignedClockConflict();
   // A received claim never signs again.
   if(offlineReceiptHeld(entry.phase))return {status:'proof_ready',requestId:id,acceptance:'not_granted'};
   const pending=(result:Exclude<NativeIntegrityResult<unknown>,{status:'evidence'}>):OfflineSignResult=>({status:'pending',requestId:id,reason:result.status==='unsupported'?'unsupported':result.status==='invalid'?'invalid_evidence':'native_unavailable'});
   async function saveEntry(next:OfflineClockCapturedClaim){
    entry=next;p={...p,claims:p.claims.map((value,at)=>at===index?entry:value)};s=await saveOffline(s,p);
   }
   if(entry.phase!=='proof_ready'){
    const verified=await verifyOffline(p.rawContext,p.binding);
    if(verified.digest!==p.digest||offlineClockContextClientData(verified.context)!==offlineClockContextClientData(context))throw new SignedClockConflict();
    if(entry.phase==='captured')await saveEntry({...entry,phase:'signing'});
    const info=await owned(()=>signer.inspect(structuredClone(p.key),structuredClone(entry.claim)));if(info.status!=='evidence')return pending(info);
    const snapshot=AppleOfflineProofSnapshot.safeParse(info.evidence);if(!snapshot.success)return {status:'pending',requestId:id,reason:'invalid_evidence'};
    let proof:string;
    if(snapshot.data.state==='completed'){
     if(p.key.platform!=='ios')return {status:'pending',requestId:id,reason:'invalid_evidence'};proof=snapshot.data.assertion;
    }else{
     if(p.key.platform==='android'&&snapshot.data.state!=='absent')return {status:'pending',requestId:id,reason:'invalid_evidence'};
     if(snapshot.data.state==='requested'&&!snapshot.data.canRetry)return {status:'pending',requestId:id,reason:'recovery_required'};
     if(entry.claim.command.photo)await owned(()=>signer.verifyPhoto(id,structuredClone(entry.claim.command.photo!)));
     const signed=await owned(()=>signer.sign(structuredClone(p.key),structuredClone(entry.claim)));if(signed.status!=='evidence')return pending(signed);proof=signed.evidence;
    }
    const parsed=(p.key.platform==='ios'?OfflineClockAppleAssertion:OfflineClockAndroidSignature).safeParse(proof);
    if(!parsed.success)return {status:'pending',requestId:id,reason:'invalid_evidence'};
    await saveEntry({...entry,phase:'proof_ready',proof:parsed.data,nativeReleased:false});
   }
   if(!entry.nativeReleased){
    const released=await owned(()=>signer.release(structuredClone(p.key),structuredClone(entry.claim)));if(released.status!=='evidence')return pending(released);
    if(released.evidence!==null)return {status:'pending',requestId:id,reason:'invalid_evidence'};
    await saveEntry({...entry,nativeReleased:true});
   }
   return {status:'proof_ready',requestId:id,acceptance:'not_granted'};
  }),
  captureOffline:(input:unknown)=>exclusive(queue,async()=>{
   const request=OfflineClockCaptureInput.parse(input);let s=await read();const p=s.offline;capturePorts();
   if(!p||p.phase!=='context_ready'||s.pending)throw new SignedClockConflict();
   const rawContext=(JSON.parse(p.rawContext) as {context:unknown}).context;
   const context=OfflineClockContextData.parse(rawContext);
   if(context.id!==request.expectedContextId)throw new SignedClockConflict();
   await verifyCapturedDigests(p);
   const existing=p.claims.findIndex(entry=>entry.claim.command.requestId===request.requestId);
   if(existing>=0){if(p.claims[existing].claim.time.claimedAt!==request.claimedAt)throw new SignedClockConflict();return completeOfflineCapture(s,p,existing);}
   if(p.claims.some(entry=>!offlineCaptureComplete(entry.phase)))throw new SignedClockConflict();
   const verified=await verifyOffline(p.rawContext,p.binding);
   if(verified.digest!==p.digest||offlineClockContextClientData(verified.context)!==offlineClockContextClientData(context))throw new SignedClockConflict();
   const permit=context.permits[p.claims.length];if(!context.policy.offlineEnabled||!permit)throw new SignedClockUnavailable('configuration');
   // Owner decision 7: refuse capture once the proven elapsed lower bound since the response reaches the context window.
   // Unknown continuity is allowed (the server reviews it); device wall time is never consulted.
   const elapsed=offlineWireElapsed(p.requestStarted,p.responseReceived,request.eventSnapshot);
   if(elapsed.status==='elapsed'&&BigInt(elapsed.minimumNs)>=BigInt(context.expiresAt-context.issuedAt)*BigInt(1000000))throw new SignedClockUnavailable('expired');
   const b=baseSchema.parse(await owned(()=>ports.base(p.binding.scope.employmentId,request.requestId)));
   if(b.command.requestId!==request.requestId)throw new SignedClockConflict();
   const result=capturePorts().capabilities();ports.assertCurrent();
   if(result.status!=='evidence')throw new SignedClockUnavailable(result.status==='unsupported'?'unsupported':'native_unavailable');
   const cap=NativeCapabilities.parse(result.evidence),key=p.key;
   if(cap.platform!==key.platform||(key.platform==='ios'?cap.keyMechanism!=='apple_app_attest'||key.appId.slice(11)!==cap.appId:cap.keyMechanism!=='android_keystore'||cap.appId!==key.appId))throw new SignedClockConflict();
   const {deviceToken,...command}=b.command;void deviceToken;
   const claim=OfflineClockClaimData.parse({version:1,purpose:'attendance.clock.offline.claim',scope:p.binding.scope,
    context:{id:context.id,sha256:p.digest},permit,chain:{sequence:p.claims.length+1,previousSha256:p.claims.at(-1)?.digest??null},
    command:{...command,photo:b.photo},time:{claimedAt:request.claimedAt,elapsed:offlineWireElapsed(p.requestStarted,p.responseReceived,request.eventSnapshot)},
    evidence:{platform:cap.platform,appId:cap.appId,appVersion:cap.appVersion,buildVersion:cap.buildVersion,...b.source}});
   const digest=sha.parse(await owned(()=>capturePorts().digest(offlineClockClaimClientData(claim))));
   const entry:OfflineClockCapturedClaim={phase:'capture_requested',baseDigest:b.digest,claim,digest,eventSnapshot:request.eventSnapshot,
    photoReference:claim.command.photo?offlineClockPhotoReference(request.requestId):null,proof:null,nativeReleased:false,receipt:null,undeliverable:null};
   const next=validateOfflineClockExchange({...p,claims:[...p.claims,entry]},scope);
   if(next.phase!=='context_ready')throw new SignedClockConflict();s=await saveOffline(s,next);
   return completeOfflineCapture(s,next,next.claims.length-1);
  }),
  reserveOffline:(input:unknown)=>exclusive(queue,async()=>{
   const binding=OfflineClockContextBinding.parse(input),s=await read();offlinePorts();
   if(s.pending)throw new SignedClockConflict();
   if(s.offline){if(!same(s.offline.binding,binding))throw new SignedClockConflict();return status(s,binding.scope.employmentId);}
   const found=await owned(()=>ports.key()),key=ClockSigningKey.parse(found.key),capability=NativeCapabilities.parse(found.capability);
   if(capability.platform!==key.platform||(key.platform==='ios'?capability.keyMechanism!=='apple_app_attest'||key.appId.slice(11)!==capability.appId:capability.keyMechanism!=='android_keystore'||key.appId!==capability.appId))throw new SignedClockConflict();
   const offline=validateOfflineClockExchange({phase:'context_requested',binding,key,requestStarted:localSnapshot()},scope);
   return status(await saveOffline(s,offline),binding.scope.employmentId);
  }),
  prepareOffline:(expectedRequestId:string)=>exclusive(queue,async()=>{
   const expected=uuid.parse(expectedRequestId),s=await read(),p=s.offline;offlinePorts();
   if(!p||s.pending||p.binding.request.requestId!==expected)throw new SignedClockConflict();
   if(p.phase==='closing')return status(s,p.binding.scope.employmentId);
   if(p.phase==='context_ready'){
    const verified=await verifyOffline(p.rawContext,p.binding);
    if(verified.digest!==p.digest||offlineClockContextClientData(verified.context)!==offlineClockContextClientData((JSON.parse(p.rawContext) as {context:unknown}).context))throw new SignedClockConflict();
    return status(s,p.binding.scope.employmentId);
   }
   const raw=await owned(()=>offlinePorts().request(structuredClone(p.binding))),responseReceived=localSnapshot();
   const verified=await verifyOffline(raw,p.binding);
   const next=validateOfflineClockExchange({...p,phase:'context_ready',rawContext:raw,digest:verified.digest,responseReceived},scope);
   const parsed=JSON.parse(raw) as {context:unknown};
   if(offlineClockContextClientData(verified.context)!==offlineClockContextClientData(parsed.context))throw new SignedClockConflict();
   return status(await saveOffline(s,next),p.binding.scope.employmentId);
  }),
  status:(employmentId:string)=>exclusive(queue,async()=>status(await read(),uuid.parse(employmentId))),
  start:(employmentId:string,requestId:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId),id=uuid.parse(requestId),s=await read();
   if(s.offline)throw new SignedClockConflict();
   if(s.pending){if(s.pending.employmentId!==selected||s.pending.requestId!==id)throw new SignedClockConflict();return status(s,selected);}
   const b=baseSchema.parse(await owned(()=>ports.base(selected,id)));if(b.command.requestId!==id)throw new SignedClockConflict();
   const found=await owned(()=>ports.key()),key=ClockSigningKey.parse(found.key),cap=NativeCapabilities.parse(found.capability),features=await capabilities(key.platform);
   if(key.actorId!==scope.actorId||key.apiOrigin!==scope.apiOrigin||key.appInstallationId!==scope.appInstallationId||cap.platform!==key.platform||
    (key.platform==='ios'?cap.keyMechanism!=='apple_app_attest'||key.appId.slice(11)!==cap.appId:cap.keyMechanism!=='android_keystore'||key.appId!==cap.appId))throw new SignedClockConflict();
   const p:SignedClockPending={phase:'intent',employmentId:selected,requestId:id,baseDigest:b.digest,action:b.command.action,key,
    evidence:OnlineClockIntegrityData.shape.evidence.parse({platform:cap.platform,appId:cap.appId,appVersion:cap.appVersion,buildVersion:cap.buildVersion,...b.source}),
    project:features.cloudProjectNumber,context:null,proof:null};
   return status(await save(s,p),selected);
  }),
  recover:(employmentId:string,abandon=false,expectedRequestId?:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId),expected=expectedRequestId===undefined?undefined:uuid.parse(expectedRequestId),s=await read(),p=s.pending;if(s.offline||!p||p.employmentId!==selected)return status(s,selected);
   if(expected!==undefined&&p.requestId!==expected)throw new SignedClockConflict();
   const value=await owned(()=>abandon?ports.abandon(selected,p.requestId):ports.receipt(selected,p.requestId)),d=checkedDisposition(value,p,abandon);
   return d?finish(s,p,d):status(s,selected,'uncertain');
  }),
  advance:(employmentId:string,expectedRequestId?:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId),expected=expectedRequestId===undefined?undefined:uuid.parse(expectedRequestId);let s=await read();const p=s.pending;
   if(s.offline||!p||p.employmentId!==selected)return status(s,selected);
   if(expected!==undefined&&p.requestId!==expected)throw new SignedClockConflict();
   const existing=await observe(s,p);if(existing)return existing;
   if(p.phase==='settled')return status(s,selected,'uncertain');
   let current:SignedClockPending=p;
   const b=await base(current),features=await capabilities(current.key.platform);if(features.cloudProjectNumber!==current.project)throw new SignedClockConflict();
   const request=intent(current,b),prepared=(current.key.platform==='ios'?C.IntegrityClockPrepared:C.IntegrityAndroidClockPrepared).parse(await owned(()=>ports.begin(structuredClone(current),structuredClone(request))));
   if(prepared.outcome!=='prepared')return status(s,selected,prepared.outcome==='refused'?'refused':'unavailable',prepared.outcome==='refused'?prepared:undefined);
   const context=prepared.context,expectedContext=OnlineClockIntegrityData.parse({...context,scope:{apiOrigin:scope.apiOrigin,actorId:scope.actorId,employmentId:selected,deviceKeyId:p.key.keyId,tenantId:p.key.tenantId,installationId:p.key.installationId},command:{...request.command,photo:b.photo},evidence:p.evidence});
   if(onlineClockClientData(context)!==onlineClockClientData(expectedContext)||p.context&&onlineClockClientData(p.context)!==onlineClockClientData(context))throw new SignedClockConflict();
   if(prepared.state!=='active')return status(s,selected,'challenge_unavailable');
   if(current.phase==='intent'){current={...current,phase:'prepared',context};s=await save(s,current);}
   if(!current.proof){
    const signingKey=structuredClone(current.key);
    const found=await owned(()=>ports.key()),freshKey=ClockSigningKey.parse(found.key),cap=NativeCapabilities.parse(found.capability);
    if(!same(freshKey,signingKey)||cap.platform!==current.evidence.platform||cap.appId!==current.evidence.appId||cap.appVersion!==current.evidence.appVersion||cap.buildVersion!==current.evidence.buildVersion)throw new SignedClockConflict();
    const signed=await owned(()=>ports.sign(signingKey,structuredClone(context)));
    if(signed.status!=='evidence')return status(s,selected,signed.status==='unsupported'?'unsupported':signed.status==='invalid'?'invalid_evidence':'native_unavailable');
    const proof=(current.key.platform==='ios'?C.IntegrityClockProof.shape.assertion:C.IntegrityAndroidClockProof.shape.signature).parse(signed.evidence);
    current={...current,phase:'proof_ready',context,proof};s=await save(s,current);
   }
   let token:string|undefined;
   if(current.key.platform==='android'){
    const project=AndroidPlayCloudProject.parse(current.project);
    const result=await owned(()=>ports.play(project,structuredClone(context)));
    if(result.status!=='evidence')return status(s,selected,result.status==='unsupported'?'unsupported':result.status==='invalid'?'invalid_evidence':'native_unavailable');token=C.IntegrityAndroidClockToken.parse(result.evidence);
   }
   if(current.phase!=='sent'){current={...current,phase:'sent'};s=await save(s,current);}
   const proof=current.key.platform==='ios'?{assertion:current.proof!}:{signature:current.proof!};
   const result=C.IntegrityClockResult.parse(await owned(()=>ports.complete(structuredClone(current),{...request,challengeId:context.challenge.id,...proof},token)));
   if(result.outcome!=='accepted')return status(s,selected,result.outcome==='refused'?'refused':'unavailable',result.outcome==='refused'?result:undefined);
   if(result.receipt.direction!==current.action)throw new SignedClockConflict();return finish(s,current,{receipt:result.receipt,abandoned:false});
  }),
 };
}
