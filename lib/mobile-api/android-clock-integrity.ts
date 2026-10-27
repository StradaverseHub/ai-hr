/** Current Google evidence policy only. Eligibility is not key ownership, GPS proof or attendance. */
import 'server-only';
import {createHash} from 'node:crypto';
import {AndroidEnrollmentSettings} from '../mobile-android-enrollment';
import {AndroidClockIntegrityPolicy} from '../mobile-android-clock-policy';
import {OnlineClockIntegrityData} from '../mobile-clock-integrity';
import {onlineClockClientDataHash} from './clock-integrity';
import {createPlayIntegrityVerifier,type PlayAccessTokenProvider,type PlayIntegrityResult} from './play-integrity';

type Refusal='invalid_proof'|'challenge_unavailable'|'stale_token'|'unrecognized_app'|'unlicensed_app'|
 'device_integrity'|'reported_mock'|'reported_simulation'|'reported_accessory';
type Unavailable='configuration_unavailable'|'provider_unavailable'|'licensing_unavailable'|
 'location_signal_unavailable'|'unknown_vendor_verdict'|'time_unavailable';
export type AndroidClockIntegrityResult=
 |{status:'refused';reason:Refusal}
 |{status:'unavailable';reason:Unavailable}
 |{status:'eligible';assessment:{version:1;verification:'google_play_standard';clientDataHash:string;
  policyDigest:string;configurationDigest:string;checkedAt:number;requestedAt:number;deviceLabels:readonly string[];
  licensing:'LICENSED'|'UNLICENSED';locationSignals:OnlineClockIntegrityData['evidence'];
  locationVerification:'not_verified';keyVerification:'not_evaluated'}};

/** Both settings and policy are trusted server inputs. Scope/challenge/command must be reconstructed
 * from authenticated stored records and exact attachment bytes; never pass an HTTP-supplied context.
 * Google decoding runs outside database locks. The acceptance transaction must separately recheck
 * ownership, signature, challenge/time, revocation, exact configuration/policy digests and command hash.
 * No decoded-verdict input, success cache or retry exists here: a timeout may have consumed a token.
 */
export function createAndroidClockIntegrityVerifier(settings:unknown,policy:unknown,accessToken:PlayAccessTokenProvider|null,
 options:{transport?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){
 const configured=AndroidEnrollmentSettings.safeParse(settings),requirements=AndroidClockIntegrityPolicy.safeParse(policy);
 const now=options.now??Date.now;
 const vendor=configured.success&&requirements.success?createPlayIntegrityVerifier({
  packageName:configured.data.target.packageName,certificateDigests:configured.data.target.certificateDigests,
  versionCodes:configured.data.target.versionCodes,
 },accessToken,options):null;
 // The parsed schema fixes property order and copies arrays/objects before any asynchronous work.
 const policyDigest=requirements.success?createHash('sha256').update(JSON.stringify(requirements.data)).digest('hex'):null;
 const configurationDigest=configured.success?createHash('sha256').update(JSON.stringify(configured.data)).digest('hex'):null;
 return async(token:unknown,request:{clientData:unknown;challengeIssuedAt:number},signal?:AbortSignal):Promise<AndroidClockIntegrityResult>=>{
  if(!vendor||!requirements.success||!policyDigest||!configurationDigest||!accessToken)return {status:'unavailable',reason:'configuration_unavailable'};
  const parsed=OnlineClockIntegrityData.safeParse(request.clientData),issuedAt=request.challengeIssuedAt;
  if(!parsed.success||parsed.data.evidence.platform!=='android')return {status:'refused',reason:'invalid_proof'};
  const context=parsed.data,p=requirements.data;
  let started:number;try{started=now();}catch{return {status:'unavailable',reason:'time_unavailable'};}
  if(!Number.isSafeInteger(started)||started<1)return {status:'unavailable',reason:'time_unavailable'};
  let checked:PlayIntegrityResult;
  try{checked=await vendor(token,{clientData:context,challengeIssuedAt:issuedAt},signal);}
  catch{return {status:'unavailable',reason:'provider_unavailable'};}
  if(checked.status==='invalid')return {status:'refused',reason:checked.reason==='expired_challenge'?'challenge_unavailable':checked.reason==='stale_token'?'stale_token':'invalid_proof'};
  if(checked.status!=='evidence')return {status:'unavailable',reason:checked.reason==='not_configured'?'configuration_unavailable':'provider_unavailable'};
  let checkedAt:number;try{checkedAt=now();}catch{return {status:'unavailable',reason:'time_unavailable'};}
  if(!Number.isSafeInteger(checkedAt)||checkedAt<started)return {status:'unavailable',reason:'time_unavailable'};
  if(signal?.aborted)return {status:'unavailable',reason:'provider_unavailable'};
  if(checkedAt>=context.challenge.expiresAt)return {status:'refused',reason:'challenge_unavailable'};
  const evidence=checked.evidence;
  if(checkedAt-evidence.requestedAt>p.maxTokenAgeMs||evidence.requestedAt-checkedAt>p.allowedFutureSkewMs)return {status:'refused',reason:'stale_token'};
  if(evidence.appRecognition!=='PLAY_RECOGNIZED')return {status:'refused',reason:'unrecognized_app'};
  if(evidence.unknownDeviceLabels)return {status:'unavailable',reason:'unknown_vendor_verdict'};
  if(!evidence.deviceLabels.includes('MEETS_DEVICE_INTEGRITY')||p.minimumDeviceIntegrity==='strong'&&!evidence.deviceLabels.includes('MEETS_STRONG_INTEGRITY'))return {status:'refused',reason:'device_integrity'};
  if(evidence.licensing==='UNEVALUATED')return {status:'unavailable',reason:'licensing_unavailable'};
  if(p.licensing==='licensed'&&evidence.licensing!=='LICENSED')return {status:'refused',reason:'unlicensed_app'};
  const signals=context.evidence;
  for(const field of ['mock','simulated','accessory'] as const){
   const rule=p.locationSignals[field];
   if(rule==='allow')continue;
   if(signals[field]===true)return {status:'refused',reason:field==='mock'?'reported_mock':field==='simulated'?'reported_simulation':'reported_accessory'};
   if(rule==='require_report'&&signals[field]===null)return {status:'unavailable',reason:'location_signal_unavailable'};
  }
  return {status:'eligible',assessment:{version:1,verification:'google_play_standard',
   clientDataHash:onlineClockClientDataHash(context).toString('hex'),policyDigest,configurationDigest,checkedAt,requestedAt:evidence.requestedAt,
   deviceLabels:[...evidence.deviceLabels],licensing:evidence.licensing,locationSignals:{...signals},
   locationVerification:'not_verified',keyVerification:'not_evaluated'}};
 };
}
