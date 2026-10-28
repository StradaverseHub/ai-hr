/** Android sync-time Play Integrity for one offline claim upload (owner decisions 4 and 5, 2026-10-28). A sibling of
 * play-integrity.ts, whose verifier is bound to online clock bytes and is deliberately left unchanged; this file reuses its
 * access-token provider type, the deployed service-account provider (play-credentials.ts) and the bounded body reader.
 *
 * Binding. The standard token's requestHash is base64url(sha256(UTF-8 JSON
 *   ['aihr.mobile.integrity',1,'attendance.clock.offline.sync',claimDigest,signatureSha256,syncBuildVersion])))
 * where claimDigest is the receipt digest (hex sha256 of offlineClockClaimClientData), signatureSha256 the hex sha256 of
 * the claim's base64-decoded original signature bytes, and syncBuildVersion the uploading build's versionCode. The
 * verdict's versionCode must equal syncBuildVersion and be one of the configured codes; the token must be younger than
 * the clock rollout policy's maxTokenAgeMs (AndroidClockIntegrityPolicy; no new policy field) and no further ahead than
 * allowedFutureSkewMs. App recognition, certificates, device integrity and licensing use that same current policy.
 *
 * Meaning. This describes the UPLOAD environment only. It does not authenticate the capture-time build, device
 * integrity, location, mock/simulated flags or time; those stay the claim's own signed reports, adjudicated as such.
 * Location-signal rules are not applied here for that reason. A failure is a transport refusal with no receipt: the
 * phone keeps the claim queued and retries; revoking the key releases a stuck queue. No retry, cache or stored verdict:
 * Google may already have consumed a token before a timeout. */
import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {readBoundedBody} from '../bounded-body';
import {AndroidEnrollmentSettings} from '../mobile-android-enrollment';
import {AndroidClockIntegrityPolicy} from '../mobile-android-clock-policy';
import {OfflineSyncBuildVersion,OfflineSyncPlayToken,type OfflineSyncIntegrityRefusal,type OfflineSyncIntegrityUnavailable} from '../mobile-offline-contract';
import type {PlayAccessTokenProvider} from './play-integrity';
const SCOPE='https://www.googleapis.com/auth/playintegrity';
const sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
// The same certificate-digest and verdict shapes the online verifier admits (play-integrity.ts), normalized identically.
const digest=z.string().max(44).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]=?$/).refine(value=>value.trim()===value).transform(value=>value.replace(/=$/,''));
const payload=z.object({tokenPayloadExternal:z.object({
 requestDetails:z.object({requestPackageName:z.string().max(255),requestHash:z.string().max(500),timestampMillis:z.string().max(16).regex(/^[1-9][0-9]*$/).refine(value=>value.trim()===value)}),
 appIntegrity:z.object({appRecognitionVerdict:z.enum(['PLAY_RECOGNIZED','UNRECOGNIZED_VERSION','UNEVALUATED']),
  packageName:z.string().max(255).optional(),certificateSha256Digest:z.array(digest).max(8).optional(),versionCode:OfflineSyncBuildVersion.optional()}),
 accountDetails:z.object({appLicensingVerdict:z.enum(['LICENSED','UNLICENSED','UNEVALUATED'])}),
 deviceIntegrity:z.object({deviceRecognitionVerdict:z.array(z.string().max(64)).max(8).optional()}),
})});
const knownLabels=['MEETS_BASIC_INTEGRITY','MEETS_DEVICE_INTEGRITY','MEETS_STRONG_INTEGRITY','MEETS_VIRTUAL_INTEGRITY'] as const;
type Refusal=z.infer<typeof OfflineSyncIntegrityRefusal>;
type Unavailable=z.infer<typeof OfflineSyncIntegrityUnavailable>;
export type OfflineSyncIntegrityRequest={claimDigest:string;signatureSha256:string;syncBuildVersion:string};
export type OfflineSyncIntegrityResult=
 |{status:'eligible';assessment:{version:1;verification:'google_play_standard';scope:'sync_upload';requestHash:string;versionCode:string;
  checkedAt:number;requestedAt:number;deviceLabels:string[];licensing:'LICENSED'|'UNLICENSED';captureVerification:'not_verified'}}
 |{status:'refused';reason:Refusal}
 |{status:'unavailable';reason:Unavailable};
/** Thrown by the deployed Android claim preparer; the transport maps it to a refusal or unavailable with no receipt. */
export class OfflineSyncIntegrityError extends Error{
 constructor(readonly result:Exclude<OfflineSyncIntegrityResult,{status:'eligible'}>){super('Offline sync integrity unavailable');this.name='OfflineSyncIntegrityError';}
}
export function offlineSyncRequestHash(request:OfflineSyncIntegrityRequest){
 return createHash('sha256').update(JSON.stringify(['aihr.mobile.integrity',1,'attendance.clock.offline.sync',request.claimDigest,request.signatureSha256,request.syncBuildVersion]),'utf8').digest('base64url');
}
/** Settings (AndroidEnrollmentSettings) and policy (AndroidClockIntegrityPolicy) are the actor's current clock rollout
 * entry; never request fields. Call outside database locks (the claim service's prepare port). */
export function createOfflineSyncIntegrityVerifier(settings:unknown,policy:unknown,accessToken:PlayAccessTokenProvider|null,
 options:{transport?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){
 const configured=AndroidEnrollmentSettings.safeParse(settings),rules=AndroidClockIntegrityPolicy.safeParse(policy);
 const transport=options.transport??fetch,now=options.now??Date.now,timeoutMs=options.timeoutMs??10000;
 const certificates=configured.success?configured.data.target.certificateDigests.map(value=>digest.safeParse(value)):[];
 const ready=configured.success&&rules.success&&accessToken!==null&&Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000&&certificates.length>0&&certificates.every(value=>value.success);
 const allowed=certificates.flatMap(value=>value.success?[value.data]:[]);
 const refused=(reason:Refusal)=>({status:'refused',reason}) as const,unavailable=(reason:Unavailable)=>({status:'unavailable',reason}) as const;
 return async(token:unknown,request:OfflineSyncIntegrityRequest,signal?:AbortSignal):Promise<OfflineSyncIntegrityResult>=>{
  if(!ready||!configured.success||!rules.success||!accessToken)return unavailable('configuration_unavailable');
  const target=configured.data.target,p=rules.data;
  if(token===undefined||token===null)return refused('token_missing');
  const opaque=OfflineSyncPlayToken.safeParse(token),build=OfflineSyncBuildVersion.safeParse(request?.syncBuildVersion);
  if(!opaque.success||!build.success||!sha.safeParse(request.claimDigest).success||!sha.safeParse(request.signatureSha256).success)return refused('invalid_input');
  // Checked before any provider call, so a build the deployment does not admit never spends a Google request.
  if(!target.versionCodes.includes(build.data))return refused('version_mismatch');
  // Narrowed here: the provider closure below cannot see the success check.
  const syncBuildVersion=build.data;
  const expectedHash=offlineSyncRequestHash({claimDigest:request.claimDigest,signatureSha256:request.signatureSha256,syncBuildVersion:build.data});
  let started:number;try{started=now();}catch{return unavailable('time_unavailable');}
  if(!Number.isSafeInteger(started)||started<1)return unavailable('time_unavailable');
  const controller=new AbortController(),cancelled=Symbol('offline-sync-integrity-cancelled');
  let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
  const interrupted=new Promise<never>((_,reject)=>{
   abort=()=>{controller.abort();reject(cancelled);};
   timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  async function execute():Promise<OfflineSyncIntegrityResult>{
   if(controller.signal.aborted)throw cancelled;
   const bearer=await accessToken!(SCOPE,controller.signal);
   if(controller.signal.aborted)throw cancelled;
   if(typeof bearer!=='string'||bearer.length<1||bearer.length>16384||bearer.trim()!==bearer||!/^[A-Za-z0-9._~+/-]+=*$/.test(bearer))return unavailable('provider_unavailable');
   const response=await transport(`https://playintegrity.googleapis.com/v1/${target.packageName}:decodeIntegrityToken`,{
    method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify({integrityToken:opaque.data}),cache:'no-store',redirect:'error',signal:controller.signal,
   });
   if(response.status!==200){void response.body?.cancel().catch(()=>{});return response.status===400?refused('invalid_token'):unavailable('provider_unavailable');}
   let decoded:ReturnType<typeof payload.safeParse>;
   try{const bytes=await readBoundedBody(response,65536,timeoutMs,controller.signal);decoded=payload.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
   catch{if(controller.signal.aborted)throw cancelled;return unavailable('provider_unavailable');}
   if(controller.signal.aborted)throw cancelled;
   if(!decoded.success)return unavailable('provider_unavailable');
   const value=decoded.data.tokenPayloadExternal,details=value.requestDetails;
   let checkedAt:number;try{checkedAt=now();}catch{return unavailable('time_unavailable');}
   if(!Number.isSafeInteger(checkedAt)||checkedAt<started)return unavailable('time_unavailable');
   if(details.requestPackageName!==target.packageName||details.requestHash!==expectedHash)return refused('request_mismatch');
   const requestedAt=Number(details.timestampMillis);
   if(!Number.isSafeInteger(requestedAt)||checkedAt-requestedAt>p.maxTokenAgeMs||requestedAt-checkedAt>p.allowedFutureSkewMs)return refused('stale_token');
   const app=value.appIntegrity;
   // Google clears reused standard tokens. Missing evaluation is never a passing cached verdict.
   if(app.appRecognitionVerdict==='UNEVALUATED')return unavailable('not_evaluated');
   if(app.packageName!==target.packageName||!app.certificateSha256Digest?.length||app.certificateSha256Digest.some(item=>!allowed.includes(item)))return refused('app_mismatch');
   if(app.versionCode!==build.data)return refused('version_mismatch');
   if(app.appRecognitionVerdict!=='PLAY_RECOGNIZED')return refused('unrecognized_app');
   const labels=value.deviceIntegrity.deviceRecognitionVerdict??[];
   if(labels.some(label=>!(knownLabels as readonly string[]).includes(label)))return unavailable('unknown_vendor_verdict');
   if(!labels.includes('MEETS_DEVICE_INTEGRITY')||p.minimumDeviceIntegrity==='strong'&&!labels.includes('MEETS_STRONG_INTEGRITY'))return refused('device_integrity');
   const licensing=value.accountDetails.appLicensingVerdict;
   if(licensing==='UNEVALUATED')return unavailable('licensing_unavailable');
   if(p.licensing==='licensed'&&licensing!=='LICENSED')return refused('unlicensed_app');
   return {status:'eligible',assessment:{version:1,verification:'google_play_standard',scope:'sync_upload',requestHash:expectedHash,versionCode:syncBuildVersion,
    checkedAt,requestedAt,deviceLabels:knownLabels.filter(label=>labels.includes(label)),licensing,captureVerification:'not_verified'}};
  }
  try{return await Promise.race([execute(),interrupted]);}
  catch{return unavailable('provider_unavailable');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 };
}
