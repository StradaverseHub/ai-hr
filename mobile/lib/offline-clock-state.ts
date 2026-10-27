/** App-local context exchange state under the installed-account proof owner. Never transport it. */
import {z} from 'zod';
import {OfflineClockContextBinding,OfflineClockContextEnvelope,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,parseOfflineClockContext} from '../../lib/mobile-offline-context';
import {OfflineClockClaimData,type OfflineClockElapsed,OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from '../../lib/mobile-offline-clock';
import {elapsedFromServerExchange} from './clock-elapsed';
import {ClockSigningKey} from './clock-signing-key';
import {NativeClockSnapshot} from './integrity-bridge';
import {EnrollmentScope} from './enrollment-journal';
const uuid=z.string().uuid().transform(value=>value.toLowerCase()),sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
export const OfflineClockCaptureInput=z.object({requestId:uuid,expectedContextId:uuid,claimedAt:z.number().int().positive().max(8640000000000000),eventSnapshot:NativeClockSnapshot}).strict();
export function offlineClockPhotoReference(requestId:string){return `offline-${uuid.parse(requestId)}.sealed`;}
export function offlineWireElapsed(start:NativeClockSnapshot,response:NativeClockSnapshot,event:NativeClockSnapshot):OfflineClockElapsed{
 const value=elapsedFromServerExchange(start,response,event);
 return value.status==='unknown'?value:{status:value.status,minimumNs:value.minimumNs,maximumNs:value.maximumNs,continuity:value.continuity};
}
export const OfflineClockCapturedClaim=z.object({phase:z.enum(['capture_requested','photo_retained','captured']),baseDigest:sha,
 claim:OfflineClockClaimData,digest:sha,eventSnapshot:NativeClockSnapshot,
 photoReference:z.string().regex(/^offline-[a-f0-9-]{36}\.sealed$/).nullable()}).strict();
export type OfflineClockCapturedClaim=z.infer<typeof OfflineClockCapturedClaim>;
const fields={binding:OfflineClockContextBinding,key:ClockSigningKey,requestStarted:NativeClockSnapshot};
export const OfflineClockExchange=z.discriminatedUnion('phase',[
 z.object({...fields,phase:z.literal('context_requested')}).strict(),
 z.object({...fields,phase:z.literal('context_ready'),rawContext:z.string().min(1).max(OFFLINE_CLOCK_CONTEXT_MAX_BYTES),
  digest:z.string().length(64).regex(/^[a-f0-9]{64}$/),responseReceived:NativeClockSnapshot,claims:z.array(OfflineClockCapturedClaim).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT).default([])}).strict(),
]);
export type OfflineClockExchange=z.infer<typeof OfflineClockExchange>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Structural validation is local storage integrity, never signature verification/attendance authority. */
export function validateOfflineClockExchange(input:unknown,scope:EnrollmentScope):OfflineClockExchange{
 const value=OfflineClockExchange.parse(input),{binding,key,requestStarted}=value,s=binding.scope;
 if(s.apiOrigin!==scope.apiOrigin||s.actorId!==scope.actorId||s.appInstallationId!==scope.appInstallationId||
  key.apiOrigin!==s.apiOrigin||key.actorId!==s.actorId||key.appInstallationId!==s.appInstallationId||key.installationId!==s.installationId||
  key.tenantId!==s.tenantId||key.keyId!==s.deviceKeyId||key.platform!==binding.target.platform||key.appId!==binding.target.appId)throw new Error('Invalid offline exchange');
 const source=key.platform==='ios'?'ios_continuous':'android_elapsed_realtime';
 if(requestStarted.source!==source)throw new Error('Invalid offline clock source');
 if(value.phase==='context_ready'){
  if(new TextEncoder().encode(value.rawContext).byteLength>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error('Invalid offline context size');
  if(value.responseReceived.source!==source)throw new Error('Invalid offline clock source');
  const raw:unknown=JSON.parse(value.rawContext);
  if(!raw||typeof raw!=='object')throw new Error('Invalid offline context');
  parseOfflineClockContext(Reflect.get(raw,'context'));
  const {context}=OfflineClockContextEnvelope.parse(raw);
  if(!same(context.scope,s)||!same(context.target,binding.target)||context.requestId!==binding.request.requestId||context.requestNonce!==binding.request.requestNonce)throw new Error('Invalid offline context binding');
  const seen=new Set<string>();
  for(const [index,entry] of value.claims.entries()){
   const claim=entry.claim,permit=context.permits[index];
   if(!permit||!context.policy.offlineEnabled||!same(claim.scope,s)||claim.context.id!==context.id||claim.context.sha256!==value.digest||
    !same(claim.permit,permit)||claim.chain.sequence!==index+1||claim.chain.previousSha256!==(index===0?null:value.claims[index-1].digest)||
    entry.eventSnapshot.source!==source||claim.evidence.platform!==key.platform||
    (key.platform==='ios'?!key.appId.endsWith('.'+claim.evidence.appId):key.appId!==claim.evidence.appId)||
    !same(claim.time.elapsed,offlineWireElapsed(requestStarted,value.responseReceived,entry.eventSnapshot))||
    entry.photoReference!==(claim.command.photo?offlineClockPhotoReference(claim.command.requestId):null)||
    seen.has(claim.command.requestId)||index<value.claims.length-1&&entry.phase!=='captured')throw new Error('Invalid offline captured claim');
   seen.add(claim.command.requestId);
  }
 }
 return value;
}

/** A phase-only local handoff advance adds no command, photo or proof. It may finish at the cap. */
export function isOfflineCaptureProgress(before:OfflineClockExchange|null|undefined,after:OfflineClockExchange|null|undefined):boolean{
 if(!before||!after||before.phase!=='context_ready'||after.phase!=='context_ready'||before.claims.length<1||before.claims.length!==after.claims.length)return false;
 const index=before.claims.length-1,old=before.claims[index],next=after.claims[index],order=['capture_requested','photo_retained','captured'];
 if(order.indexOf(next.phase)!==order.indexOf(old.phase)+1)return false;
 return same({...before,claims:before.claims.map((entry,at)=>at===index?{...entry,phase:next.phase}:entry)},after);
}
