/** App-local context exchange state under the installed-account proof owner. Never transport it. */
import {z} from 'zod';
import {OfflineClockContextBinding,OfflineClockContextEnvelope,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,parseOfflineClockContext} from '../../lib/mobile-offline-context';
import {OfflineClockClaimData,OfflineClockAppleAssertion,OfflineClockAndroidSignature,type OfflineClockElapsed,OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from '../../lib/mobile-offline-clock';
import {elapsedFromServerExchange} from './clock-elapsed';
import {ClockSigningKey} from './clock-signing-key';
import {NativeClockSnapshot,type NativeIntegrityResult,type AppleOfflineProofSnapshot} from './integrity-bridge';
import {EnrollmentScope} from './enrollment-journal';
const uuid=z.string().uuid().transform(value=>value.toLowerCase()),sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
export const OfflineClockCaptureInput=z.object({requestId:uuid,expectedContextId:uuid,claimedAt:z.number().int().positive().max(8640000000000000),eventSnapshot:NativeClockSnapshot}).strict();
export function offlineClockPhotoReference(requestId:string){return `offline-${uuid.parse(requestId)}.sealed`;}
export function offlineWireElapsed(start:NativeClockSnapshot,response:NativeClockSnapshot,event:NativeClockSnapshot):OfflineClockElapsed{
 const value=elapsedFromServerExchange(start,response,event);
 return value.status==='unknown'?value:{status:value.status,minimumNs:value.minimumNs,maximumNs:value.maximumNs,continuity:value.continuity};
}
export const OfflineClockCapturedClaim=z.object({phase:z.enum(['capture_requested','photo_retained','captured','signing','proof_ready']),baseDigest:sha,
 claim:OfflineClockClaimData,digest:sha,eventSnapshot:NativeClockSnapshot,
 photoReference:z.string().regex(/^offline-[a-f0-9-]{36}\.sealed$/).nullable(),proof:z.string().min(4).max(10924).nullable().default(null),nativeReleased:z.boolean().default(false)}).strict();
export type OfflineClockCapturedClaim=z.infer<typeof OfflineClockCapturedClaim>;
export type OfflineClockProofPorts={
 inspect(key:ClockSigningKey,claim:OfflineClockClaimData):Promise<NativeIntegrityResult<AppleOfflineProofSnapshot>>;
 sign(key:ClockSigningKey,claim:OfflineClockClaimData):Promise<NativeIntegrityResult<string>>;
 release(key:ClockSigningKey,claim:OfflineClockClaimData):Promise<NativeIntegrityResult<null>>;
 verifyPhoto(requestId:string,photo:NonNullable<OfflineClockClaimData['command']['photo']>):Promise<void>;
};
export const offlineCaptureComplete=(phase:OfflineClockCapturedClaim['phase'])=>phase==='captured'||phase==='signing'||phase==='proof_ready';
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
  const seen=new Set<string>();let proofPrefixReady=true;
  for(const [index,entry] of value.claims.entries()){
   const claim=entry.claim,permit=context.permits[index];
   if(!permit||!context.policy.offlineEnabled||!same(claim.scope,s)||claim.context.id!==context.id||claim.context.sha256!==value.digest||
    !same(claim.permit,permit)||claim.chain.sequence!==index+1||claim.chain.previousSha256!==(index===0?null:value.claims[index-1].digest)||
    entry.eventSnapshot.source!==source||claim.evidence.platform!==key.platform||
    (key.platform==='ios'?key.appId.slice(11)!==claim.evidence.appId:key.appId!==claim.evidence.appId)||
    !same(claim.time.elapsed,offlineWireElapsed(requestStarted,value.responseReceived,entry.eventSnapshot))||
    entry.photoReference!==(claim.command.photo?offlineClockPhotoReference(claim.command.requestId):null)||
    seen.has(claim.command.requestId)||index<value.claims.length-1&&!offlineCaptureComplete(entry.phase))throw new Error('Invalid offline captured claim');
   if(entry.phase==='proof_ready'?(entry.proof===null||!(key.platform==='ios'?OfflineClockAppleAssertion:OfflineClockAndroidSignature).safeParse(entry.proof).success):(entry.proof!==null||entry.nativeReleased))throw new Error('Invalid offline proof state');
   if((entry.phase==='signing'||entry.phase==='proof_ready')&&!proofPrefixReady)throw new Error('Invalid offline proof order');
   proofPrefixReady=proofPrefixReady&&entry.phase==='proof_ready'&&entry.nativeReleased;
   seen.add(claim.command.requestId);
  }
 }
 return value;
}

/** Only phase reservations/handoffs or native-cache cleanup may finish at the cap, never new data. */
export function isOfflineCaptureProgress(before:OfflineClockExchange|null|undefined,after:OfflineClockExchange|null|undefined):boolean{
 if(!before||!after||before.phase!=='context_ready'||after.phase!=='context_ready'||before.claims.length<1||before.claims.length!==after.claims.length)return false;
 const changed=before.claims.flatMap((entry,index)=>same(entry,after.claims[index])?[]:[index]);if(changed.length!==1)return false;
 const index=changed[0],old=before.claims[index],next=after.claims[index],order=['capture_requested','photo_retained','captured','signing'];
 let expected:OfflineClockCapturedClaim;
 if(old.phase==='proof_ready'&&next.phase==='proof_ready'&&!old.nativeReleased&&next.nativeReleased)expected={...old,nativeReleased:true};
 else {const rank=order.indexOf(old.phase);if(rank<0||order.indexOf(next.phase)!==rank+1)return false;expected={...old,phase:next.phase};}
 return same({...before,claims:before.claims.map((entry,at)=>at===index?expected:entry)},after);
}
