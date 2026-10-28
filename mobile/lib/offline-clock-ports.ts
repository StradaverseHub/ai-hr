/** Live offline ports for the installed-account clock journal (ADR-0088; owner decisions 2026-10-28). Assembled by
 * openOwnedSignedClock only when the offline build switch is on. Nothing here authorizes attendance: the server's
 * processed receipt is the only claim outcome, and a verified context only proves what the server signed. */
import {CryptoDigestAlgorithm,CryptoEncoding,digest,digestStringAsync} from 'expo-crypto';
import {apiGet,apiPost} from './api';
import {OfflineContextIssueRequest,OfflineContextCloseRequest,OfflineSyncBuildVersion,OfflineSyncPlayToken} from '../../lib/mobile-offline-contract';
import {OfflineClockSignedClaim,type OfflineClockClaimData} from '../../lib/mobile-offline-clock';
import {verifyNativeOfflineClockContext} from './offline-context';
import {createOfflineClockSigner} from './offline-clock-signing';
import {anchoredIdentity,readIssuerRegistry,writeIssuerRegistry} from './offline-anchor';
import {offlineSyncRequestHash} from './offline-sync-hash';
import {SignedClockConflict,SignedClockUnavailable,type SignedClockPorts,type SignedClockReference} from './signed-clock-journal';
import type {createIntegrityBridge} from './integrity-bridge';
type Photo=NonNullable<OfflineClockClaimData['command']['photo']>;
/** A context request answered without issuing: `refused`/`unavailable` with the server's code. */
export class OfflineServerAnswer extends Error{
 constructor(readonly answer:{outcome:'refused'|'unavailable';code:string;integrityReason?:string}){super('Offline context not issued');this.name='OfflineServerAnswer';}
}
export type OfflineClockPortDeps={platform:'ios'|'android';employmentId:string;namespace:string;apiOrigin:string;
 check():void;operation:{assertCurrent():void};isForeground():boolean;native:ReturnType<typeof createIntegrityBridge>;
 /** The installed-account store's guarded photo custody (readOfflinePhoto / retainOfflinePhoto / deleteOfflinePhoto). */
 photos:{read(requestId:string,photo:Photo):Promise<Uint8Array>;retain(requestId:string,photo:Photo,bytes:Uint8Array):Promise<string>;remove(requestId:string):Promise<void>};
 /** Decrypted bytes of the saved base command's photo (the original capture), for the one retained offline copy. */
 basePhoto(requestId:string):Promise<Uint8Array>;
 resolveBase(reference:SignedClockReference):Promise<void>;
 /** Android: the online clock capabilities' Play cloud project number (read online at upload time). */
 cloudProject():Promise<string|null>;
};
const sha256=async(bytes:Uint8Array)=>new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256,new Uint8Array(bytes)));
const unavailable=(status:string)=>new SignedClockUnavailable(status==='unsupported'?'unsupported':'native_unavailable');
/** The offline cold-start identity for openOwnedSignedClock (see offline-anchor.ts). */
export const offlineClockIdentity=anchoredIdentity;
/** Owner decision 5: the server's offline capabilities. A successful answer for this exact origin replaces the cached
 * issuer registry (used to verify contexts, including offline at capture time). */
export async function readOfflineCapabilities(d:Pick<OfflineClockPortDeps,'platform'|'employmentId'|'namespace'|'apiOrigin'|'check'>){
 d.check();const value=await apiGet(d.platform==='ios'?'v2/integrity/ios/offline/capabilities':'v2/integrity/android/offline/capabilities',{employmentId:d.employmentId});d.check();
 if(value.outcome==='offline'&&value.apiOrigin===d.apiOrigin){await writeIssuerRegistry({namespace:d.namespace,apiOrigin:d.apiOrigin,platform:d.platform,issuers:value.issuers},d.check);d.check();}
 return value;
}
export function createOfflineClockPorts(d:OfflineClockPortDeps):NonNullable<SignedClockPorts['offline']>{
 const p=d.platform;
 async function owned<T>(run:()=>Promise<T>){d.check();try{const value=await run();d.check();return value;}catch(error){d.check();throw error;}}
 return {
  snapshot:()=>d.native.clockSnapshot(),
  async request(binding){
   if(binding.scope.employmentId!==d.employmentId)throw new SignedClockConflict();
   const result=await owned(()=>apiPost(p==='ios'?'v2/integrity/ios/offline/context':'v2/integrity/android/offline/context',OfflineContextIssueRequest.parse(binding.request),{employmentId:d.employmentId},d.operation));
   if(result.outcome==='issued')return result.context;
   throw new OfflineServerAnswer(result);
  },
  async verify(raw,binding){
   const issuers=await owned(()=>readIssuerRegistry({namespace:d.namespace,apiOrigin:d.apiOrigin,platform:p},d.check));
   if(!issuers)throw new SignedClockUnavailable('configuration');
   return verifyNativeOfflineClockContext(raw,issuers,binding,d.check);
  },
  signing:{...createOfflineClockSigner(d.native,d.check,d.isForeground),verifyPhoto:async(requestId,photo)=>{await owned(()=>d.photos.read(requestId,photo));}},
  capture:{
   capabilities:()=>d.native.capabilities(),
   digest:canonical=>owned(()=>digestStringAsync(CryptoDigestAlgorithm.SHA256,canonical,{encoding:CryptoEncoding.HEX})),
   async retainPhoto(requestId,expected){const bytes=await owned(()=>d.basePhoto(requestId));return owned(()=>d.photos.retain(requestId,expected,bytes));},
   releaseBase:reference=>owned(()=>d.resolveBase(reference)),
  },
  sync:{
   /** The exact saved claim and its retained photo bytes. iPhone: no native call (the claim's own assertion is the
    * proof). Android: a fresh standard Play token per attempt, bound to digest + original signature + running build. */
   async upload(signed,entry){
    const value=OfflineClockSignedClaim.parse(signed),photo=value.claim.command.photo;
    if(value.proof.platform!==p||value.claim.scope.employmentId!==d.employmentId||value.claim.command.requestId!==entry.requestId)throw new SignedClockConflict();
    const form=new FormData();form.append('claim',JSON.stringify(value));
    if(photo){
     const bytes=await owned(()=>d.photos.read(entry.requestId,photo));
     // Expo fetch reads the part's bytes; no plaintext copy is written to disk.
     form.append('photo',{name:photo.mimeType==='image/png'?'photo.png':'photo.jpg',type:photo.mimeType,bytes:async()=>bytes} as unknown as Blob);
    }
    if(value.proof.platform==='android'){
     const capability=d.native.capabilities();d.check();
     if(capability.status!=='evidence')throw unavailable(capability.status);
     if(capability.evidence.platform!=='android')throw new SignedClockConflict();
     const build=OfflineSyncBuildVersion.safeParse(capability.evidence.buildVersion);if(!build.success)throw new SignedClockUnavailable('configuration');
     const project=await owned(()=>d.cloudProject());if(!project)throw new SignedClockUnavailable('configuration');
     const requestHash=await owned(()=>offlineSyncRequestHash({claimDigest:entry.digest,signature:value.proof.platform==='android'?value.proof.signature:'',syncBuildVersion:build.data},sha256));
     const prepared=await owned(()=>d.native.preparePlayIntegrity(project));if(prepared.status!=='evidence')throw unavailable(prepared.status);
     const token=await owned(()=>d.native.requestPlayIntegrity(requestHash));if(token.status!=='evidence')throw unavailable(token.status);
     form.append('playIntegrityToken',OfflineSyncPlayToken.parse(token.evidence));form.append('syncBuildVersion',build.data);
    }
    d.check();
    return owned(()=>apiPost(p==='ios'?'v2/integrity/ios/offline/claim':'v2/integrity/android/offline/claim',form,{employmentId:d.employmentId},d.operation));
   },
   close:request=>owned(()=>apiPost(p==='ios'?'v2/integrity/ios/offline/context/close':'v2/integrity/android/offline/context/close',OfflineContextCloseRequest.parse(request),{employmentId:d.employmentId},d.operation)),
   deletePhoto:requestId=>owned(()=>d.photos.remove(requestId)),
  },
 };
}
