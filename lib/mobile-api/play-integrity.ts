/** Standard-token server boundary. A decoded vendor verdict is not key ownership or attendance. */
import 'server-only';
import {z} from 'zod';
import {readBoundedBody} from '../bounded-body';
import {OnlineClockIntegrityData} from '../mobile-clock-integrity';
import {onlineClockClientDataHash} from './clock-integrity';

const digest=z.string().max(44).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]=?$/).refine(value=>value.trim()===value).transform(value=>value.replace(/=$/,''));
const version=z.string().max(19).regex(/^[1-9][0-9]*$/).refine(value=>value.trim()===value&&BigInt(value)<=BigInt('9223372036854775807'));
const configuration=z.object({packageName:z.string().max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/).refine(value=>value.trim()===value),
  certificateDigests:z.array(digest).min(1).max(8),versionCodes:z.array(version).min(1).max(20)}).strict();
const payload=z.object({tokenPayloadExternal:z.object({
  requestDetails:z.object({requestPackageName:z.string().max(255),requestHash:z.string().max(500),timestampMillis:z.string().max(16).regex(/^[1-9][0-9]*$/).refine(value=>value.trim()===value)}),
  appIntegrity:z.object({appRecognitionVerdict:z.enum(['PLAY_RECOGNIZED','UNRECOGNIZED_VERSION','UNEVALUATED']),
    packageName:z.string().max(255).optional(),certificateSha256Digest:z.array(digest).max(8).optional(),versionCode:version.optional()}),
  accountDetails:z.object({appLicensingVerdict:z.enum(['LICENSED','UNLICENSED','UNEVALUATED'])}),
  deviceIntegrity:z.object({deviceRecognitionVerdict:z.array(z.string().max(64)).max(8).optional()}),
})});
const knownLabels=['MEETS_BASIC_INTEGRITY','MEETS_DEVICE_INTEGRITY','MEETS_STRONG_INTEGRITY','MEETS_VIRTUAL_INTEGRITY'] as const;
type DeviceLabel=typeof knownLabels[number];
export type PlayIntegrityResult=
  |{status:'evidence';vendorVerification:'google_api';evidence:{appRecognition:'PLAY_RECOGNIZED'|'UNRECOGNIZED_VERSION';
    licensing:'LICENSED'|'UNLICENSED'|'UNEVALUATED';deviceLabels:DeviceLabel[];unknownDeviceLabels:boolean;requestedAt:number}}
  |{status:'invalid';reason:'invalid_input'|'expired_challenge'|'request_mismatch'|'stale_token'|'app_mismatch'|'invalid_token'}
  |{status:'unavailable';reason:'not_configured'|'provider_unavailable'|'provider_configuration'|'rate_limited'|'timeout'|'aborted'|'malformed_response'|'not_evaluated'};
export type PlayAccessTokenProvider=(scope:string,signal:AbortSignal)=>Promise<string>;
const SCOPE='https://www.googleapis.com/auth/playintegrity';

/** Config/provider/clock are deployment-owned. clientData and challengeIssuedAt must be reconstructed
 * from authenticated enrollment/challenge records, not accepted as authority from the phone.
 * No automatic retry: Google may already have consumed a token before a timeout or disconnect.
 */
export function createPlayIntegrityVerifier(config:unknown,accessToken:PlayAccessTokenProvider|null,
  options:{transport?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){
  const parsedConfig=configuration.safeParse(config),transport=options.transport??fetch,now=options.now??Date.now,timeoutMs=options.timeoutMs??10000;
  const configured=parsedConfig.success&&accessToken!==null&&Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000;
  return async(token:unknown,request:{clientData:unknown;challengeIssuedAt:number},signal?:AbortSignal):Promise<PlayIntegrityResult>=>{
    if(!configured||!parsedConfig.success||!accessToken)return {status:'unavailable',reason:'not_configured'};
    const settings=parsedConfig.data,command=OnlineClockIntegrityData.safeParse(request.clientData),started=now();
    if(!command.success||typeof token!=='string'||token.length<1||token.length>32768||token.trim()!==token||!/^[\x21-\x7e]+$/.test(token)||
      !Number.isSafeInteger(started)||!Number.isSafeInteger(request.challengeIssuedAt)||request.challengeIssuedAt<1||
      command.data.evidence.platform!=='android'||command.data.evidence.appId!==settings.packageName||
      !settings.versionCodes.includes(command.data.evidence.buildVersion))return {status:'invalid',reason:'invalid_input'};
    const expires=command.data.challenge.expiresAt;
    if(request.challengeIssuedAt>started||request.challengeIssuedAt>=expires||started>expires)return {status:'invalid',reason:'expired_challenge'};
    const expectedHash=onlineClockClientDataHash(command.data).toString('base64url');
    const controller=new AbortController(),cancelled=Symbol('play-integrity-cancelled');
    let stopped:'timeout'|'aborted'|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
    const interrupted=new Promise<never>((_,reject)=>{
      abort=()=>{stopped='aborted';controller.abort();reject(cancelled);};
      timer=setTimeout(()=>{stopped='timeout';controller.abort();reject(cancelled);},timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
    async function execute():Promise<PlayIntegrityResult>{
      if(controller.signal.aborted)throw cancelled;
      const bearer=await accessToken!(SCOPE,controller.signal);
      if(controller.signal.aborted)throw cancelled;
      if(typeof bearer!=='string'||bearer.length<1||bearer.length>16384||bearer.trim()!==bearer||!/^[A-Za-z0-9._~+/-]+=*$/.test(bearer))return {status:'unavailable',reason:'provider_configuration'};
      const response=await transport(`https://playintegrity.googleapis.com/v1/${settings.packageName}:decodeIntegrityToken`,{
        method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',accept:'application/json'},
        body:JSON.stringify({integrity_token:token}),cache:'no-store',redirect:'error',signal:controller.signal,
      });
      if(response.status!==200){
        void response.body?.cancel().catch(()=>{});
        if(response.status===400)return {status:'invalid',reason:'invalid_token'};
        return {status:'unavailable',reason:response.status===401||response.status===403?'provider_configuration':response.status===429?'rate_limited':'provider_unavailable'};
      }
      let decoded:ReturnType<typeof payload.safeParse>;
      try{const bytes=await readBoundedBody(response,65536,timeoutMs,controller.signal);decoded=payload.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
      catch{if(controller.signal.aborted)throw cancelled;return {status:'unavailable',reason:'malformed_response'};}
      if(controller.signal.aborted)throw cancelled;
      if(!decoded.success)return {status:'unavailable',reason:'malformed_response'};
      const value=decoded.data.tokenPayloadExternal,details=value.requestDetails,checkedAt=now();
      if(!Number.isSafeInteger(checkedAt)||checkedAt<started)return {status:'unavailable',reason:'provider_configuration'};
      if(checkedAt>expires)return {status:'invalid',reason:'expired_challenge'};
      if(details.requestPackageName!==settings.packageName||details.requestHash!==expectedHash)return {status:'invalid',reason:'request_mismatch'};
      const timestamp=Number(details.timestampMillis);
      if(!Number.isSafeInteger(timestamp)||timestamp<request.challengeIssuedAt||timestamp>checkedAt+30000||timestamp>expires)return {status:'invalid',reason:'stale_token'};
      const app=value.appIntegrity;
      // Google clears reused standard tokens. Missing evaluation is never a passing cached verdict.
      if(app.appRecognitionVerdict==='UNEVALUATED')return {status:'unavailable',reason:'not_evaluated'};
      if(app.packageName!==settings.packageName||app.versionCode!==command.data.evidence.buildVersion||!settings.versionCodes.includes(app.versionCode)||
        !app.certificateSha256Digest?.length||app.certificateSha256Digest.some(item=>!settings.certificateDigests.includes(item)))return {status:'invalid',reason:'app_mismatch'};
      const labels=value.deviceIntegrity.deviceRecognitionVerdict??[];
      return {status:'evidence',vendorVerification:'google_api',evidence:{appRecognition:app.appRecognitionVerdict,
        licensing:value.accountDetails.appLicensingVerdict,deviceLabels:knownLabels.filter(label=>labels.includes(label)),
        unknownDeviceLabels:labels.some(label=>!knownLabels.includes(label as DeviceLabel)),requestedAt:timestamp}};
    }
    try{return await Promise.race([execute(),interrupted]);}
    catch{return {status:'unavailable',reason:stopped??'provider_unavailable'};}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
}
