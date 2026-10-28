/** App-local context exchange state under the installed-account proof owner. Never transport it. */
import {z} from 'zod';
import {OfflineClockContextBinding,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,parseOfflineClockContextJson} from '../../lib/mobile-offline-context';
import {OfflineClockClaimData,OfflineClockAppleAssertion,OfflineClockAndroidSignature,type OfflineClockElapsed,OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from '../../lib/mobile-offline-clock';
import {OfflineClockReceipt} from '../../lib/mobile-offline-receipt';
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
/** Delivery that can never succeed (owner decision 2, 2026-10-28). The first undeliverable claim makes every later claim
 * undeliverable too (its chain predecessor is never consumed); a later claim the employee removes records that as
 * earlier_undeliverable. `dismissed` is the employee's confirmed removal: the bytes stay (bounded) until the exchange
 * clears, its photo is deleted, and it never reaches the server. Local bookkeeping, never a server outcome. */
export const OfflineUndeliverableReason=z.enum(['key_unavailable','context_closed','context_unavailable','binding_conflict','invalid_proof','attachment_mismatch','invalid_claim','bad_request','earlier_undeliverable']);
export type OfflineUndeliverableReason=z.infer<typeof OfflineUndeliverableReason>;
/** C1 capture_requested, C2 photo_retained, C3 captured, C4 signing, C5 proof_ready, C6 receipt_saved (the validated
 * terminal server receipt), C7 photo_deleted (local photo custody ended after the receipt). */
export const OfflineClockCapturedClaim=z.object({phase:z.enum(['capture_requested','photo_retained','captured','signing','proof_ready','receipt_saved','photo_deleted']),baseDigest:sha,
 claim:OfflineClockClaimData,digest:sha,eventSnapshot:NativeClockSnapshot,
 photoReference:z.string().regex(/^offline-[a-f0-9-]{36}\.sealed$/).nullable(),proof:z.string().min(4).max(10924).nullable().default(null),nativeReleased:z.boolean().default(false),
 receipt:OfflineClockReceipt.nullable().default(null),undeliverable:z.object({reason:OfflineUndeliverableReason,dismissed:z.boolean()}).strict().nullable().default(null)}).strict();
export type OfflineClockCapturedClaim=z.infer<typeof OfflineClockCapturedClaim>;
export const offlineProofHeld=(phase:OfflineClockCapturedClaim['phase'])=>phase==='proof_ready'||phase==='receipt_saved'||phase==='photo_deleted';
export const offlineReceiptHeld=(phase:OfflineClockCapturedClaim['phase'])=>phase==='receipt_saved'||phase==='photo_deleted';
/** Ready to upload: durable proof and released native custody (C5 with nativeReleased). */
export const offlineUploadReady=(entry:OfflineClockCapturedClaim)=>entry.phase==='proof_ready'&&entry.nativeReleased;
/** A receipt, or the employee's confirmed removal: nothing more will be sent for this claim. */
export const offlineClaimSettled=(entry:OfflineClockCapturedClaim)=>offlineReceiptHeld(entry.phase)||!!entry.undeliverable?.dismissed;
/** The exact server receipt for this claim: same request, context, sequence, digest and photo. Anything else is a conflict. */
export function offlineReceiptMatches(receipt:OfflineClockReceipt,entry:OfflineClockCapturedClaim){
 const c=entry.claim;
 return receipt.requestId===c.command.requestId&&receipt.contextId===c.context.id&&receipt.sequence===c.chain.sequence&&receipt.digest===entry.digest&&
  (receipt.photo?.sha256??null)===(c.command.photo?.sha256??null);
}
export type OfflineClockProofPorts={
 inspect(key:ClockSigningKey,claim:OfflineClockClaimData):Promise<NativeIntegrityResult<AppleOfflineProofSnapshot>>;
 sign(key:ClockSigningKey,claim:OfflineClockClaimData):Promise<NativeIntegrityResult<string>>;
 release(key:ClockSigningKey,claim:OfflineClockClaimData):Promise<NativeIntegrityResult<null>>;
 verifyPhoto(requestId:string,photo:NonNullable<OfflineClockClaimData['command']['photo']>):Promise<void>;
};
export const offlineCaptureComplete=(phase:OfflineClockCapturedClaim['phase'])=>phase==='captured'||phase==='signing'||offlineProofHeld(phase);
const fields={binding:OfflineClockContextBinding,key:ClockSigningKey,requestStarted:NativeClockSnapshot};
const ready={...fields,rawContext:z.string().min(1).max(OFFLINE_CLOCK_CONTEXT_MAX_BYTES),
 digest:z.string().length(64).regex(/^[a-f0-9]{64}$/),responseReceived:NativeClockSnapshot,claims:z.array(OfflineClockCapturedClaim).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT).default([])};
/** E1 context_requested, E2 context_ready, E3 closing (the close request saved before its POST, so a retry resends the
 * identical closeRequestId/consumedThrough). E4 closed is the snapshot's offline:null. */
export const OfflineClockExchange=z.discriminatedUnion('phase',[
 z.object({...fields,phase:z.literal('context_requested')}).strict(),
 z.object({...ready,phase:z.literal('context_ready')}).strict(),
 z.object({...ready,phase:z.literal('closing'),close:z.object({requestId:uuid,consumedThrough:z.number().int().min(0).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT)}).strict()}).strict(),
]);
export type OfflineClockExchange=z.infer<typeof OfflineClockExchange>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Structural validation is local storage integrity, never context verification/attendance authority. rawContext is the
 * exact canonical context JSON the server handed out (D16: unsigned; the server's record is the authority). */
export function validateOfflineClockExchange(input:unknown,scope:EnrollmentScope):OfflineClockExchange{
 const value=OfflineClockExchange.parse(input),{binding,key,requestStarted}=value,s=binding.scope;
 if(s.apiOrigin!==scope.apiOrigin||s.actorId!==scope.actorId||s.appInstallationId!==scope.appInstallationId||
  key.apiOrigin!==s.apiOrigin||key.actorId!==s.actorId||key.appInstallationId!==s.appInstallationId||key.installationId!==s.installationId||
  key.tenantId!==s.tenantId||key.keyId!==s.deviceKeyId||key.platform!==binding.target.platform||key.appId!==binding.target.appId)throw new Error('Invalid offline exchange');
 const source=key.platform==='ios'?'ios_continuous':'android_elapsed_realtime';
 if(requestStarted.source!==source)throw new Error('Invalid offline clock source');
 if(value.phase!=='context_requested'){
  if(new TextEncoder().encode(value.rawContext).byteLength>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error('Invalid offline context size');
  if(value.responseReceived.source!==source)throw new Error('Invalid offline clock source');
  const context=parseOfflineClockContextJson(value.rawContext);
  if(!same(context.scope,s)||!same(context.target,binding.target)||context.requestId!==binding.request.requestId||context.requestNonce!==binding.request.requestNonce)throw new Error('Invalid offline context binding');
  const seen=new Set<string>();let proofPrefixReady=true,receiptPrefix=true,undeliverableSeen=false;
  for(const [index,entry] of value.claims.entries()){
   const claim=entry.claim,permit=context.permits[index];
   if(!permit||!context.policy.offlineEnabled||!same(claim.scope,s)||claim.context.id!==context.id||claim.context.sha256!==value.digest||
    !same(claim.permit,permit)||claim.chain.sequence!==index+1||claim.chain.previousSha256!==(index===0?null:value.claims[index-1].digest)||
    entry.eventSnapshot.source!==source||claim.evidence.platform!==key.platform||
    (key.platform==='ios'?key.appId.slice(11)!==claim.evidence.appId:key.appId!==claim.evidence.appId)||
    !same(claim.time.elapsed,offlineWireElapsed(requestStarted,value.responseReceived,entry.eventSnapshot))||
    entry.photoReference!==(claim.command.photo?offlineClockPhotoReference(claim.command.requestId):null)||
    seen.has(claim.command.requestId)||index<value.claims.length-1&&!offlineCaptureComplete(entry.phase))throw new Error('Invalid offline captured claim');
   if(offlineProofHeld(entry.phase)?(entry.proof===null||!(key.platform==='ios'?OfflineClockAppleAssertion:OfflineClockAndroidSignature).safeParse(entry.proof).success):(entry.proof!==null||entry.nativeReleased))throw new Error('Invalid offline proof state');
   if((entry.phase==='signing'||offlineProofHeld(entry.phase))&&!proofPrefixReady)throw new Error('Invalid offline proof order');
   proofPrefixReady=proofPrefixReady&&offlineProofHeld(entry.phase)&&entry.nativeReleased;
   // Receipts form a strict prefix (upload order), each the exact receipt of its claim; none beside an undeliverable mark.
   const received=offlineReceiptHeld(entry.phase);
   if(received!==(entry.receipt!==null)||received&&(!entry.nativeReleased||!receiptPrefix||entry.undeliverable!==null||!offlineReceiptMatches(entry.receipt!,entry)))throw new Error('Invalid offline receipt state');
   receiptPrefix=receiptPrefix&&received;
   if(entry.undeliverable&&(!offlineCaptureComplete(entry.phase)||entry.undeliverable.reason==='earlier_undeliverable'&&!undeliverableSeen))throw new Error('Invalid offline delivery state');
   undeliverableSeen=undeliverableSeen||entry.undeliverable!==null;
   seen.add(claim.command.requestId);
  }
  if(value.phase==='closing'&&(!value.claims.every(offlineClaimSettled)||value.close.consumedThrough!==value.claims.filter(entry=>offlineReceiptHeld(entry.phase)).length))throw new Error('Invalid offline close state');
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

/** Resolution progress that may finish at the installation cap: a receipt saved for a ready claim, a photo deletion, an
 * undeliverable mark/removal, or the close request and its reversal. It never adds a claim, proof or context. */
export function isOfflineResolution(before:OfflineClockExchange|null|undefined,after:OfflineClockExchange|null|undefined):boolean{
 if(!before||!after||before.phase==='context_requested'||after.phase==='context_requested'||before.claims.length!==after.claims.length)return false;
 const frame=(value:Exclude<OfflineClockExchange,{phase:'context_requested'}>)=>[value.binding,value.key,value.requestStarted,value.rawContext,value.digest,value.responseReceived];
 if(!same(frame(before),frame(after)))return false;
 return before.claims.every((old,index)=>{
  const next=after.claims[index];if(same(old,next))return true;
  if(old.phase==='proof_ready'&&next.phase==='receipt_saved'&&old.nativeReleased)return same({...old,phase:next.phase,receipt:next.receipt,undeliverable:null},next);
  if(old.phase==='receipt_saved'&&next.phase==='photo_deleted')return same({...old,phase:next.phase},next);
  return same({...old,undeliverable:next.undeliverable},next);
 });
}
