/** Unmounted current-device clock carrier. Vendor verification precedes transaction acquisition. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import type {AndroidClockSignatureInput} from '../../core/mobile-android-clock-signature';
import {AndroidEnrollmentSettings} from '../../lib/mobile-android-enrollment';
import {AndroidClockIntegrityPolicy,AndroidClockOpaqueToken} from '../../lib/mobile-android-clock-policy';
import {createAndroidClockIntegrityVerifier,type AndroidClockIntegrityResult} from '../../lib/mobile-api/android-clock-integrity';
import type {PlayAccessTokenProvider} from '../../lib/mobile-api/play-integrity';
import {onlineClockClientDataHash} from '../../lib/mobile-api/clock-integrity';
import {createAndroidClockService} from './mobile-android-clock';

type Failure=Exclude<AndroidClockIntegrityResult,{status:'eligible'}>;
export class AndroidClockIntegrityError extends Error{
 constructor(readonly result:Failure){super('Current device evidence unavailable');this.name='AndroidClockIntegrityError';}
}
const unavailable=()=>new AndroidClockIntegrityError({status:'unavailable',reason:'configuration_unavailable'});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A deployment transaction guard is mandatory. It must re-read its current clock rollout/settings
 * using the supplied transaction, after vendor work, and refuse changed/disabled configuration.
 * This factory neither loads enrollment rollout nor enables a route. No network work belongs in
 * beforeCommit. Receipt-only replay remains possible without a working Google credential provider.
 */
export function createAndroidVerifiedClockService(settings:unknown,policy:unknown,accessToken:PlayAccessTokenProvider|null,
 ports:{beforeCommit?:(tx:Tx)=>Promise<void>;transport?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){
 const config=AndroidEnrollmentSettings.safeParse(settings),requirements=AndroidClockIntegrityPolicy.safeParse(policy),guard=ports.beforeCommit;
 if(!config.success||!requirements.success||typeof guard!=='function')throw unavailable();
 const configuration=config.data,p=requirements.data,configurationDigest=digest(configuration),policyDigest=digest(p);
 const verify=createAndroidClockIntegrityVerifier(configuration,p,accessToken,ports);
 const base=createAndroidClockService(configuration);
 return {
  begin(ctx:SessionContext,input:AndroidClockSignatureInput){
   if(!accessToken)throw unavailable();
   return base.begin(ctx,input);
  },
  async complete(ctx:SessionContext,input:AndroidClockSignatureInput,proof:{challengeId:string;signature:Buffer;playIntegrityToken:string},signal?:AbortSignal){
   const token=AndroidClockOpaqueToken.safeParse(proof.playIntegrityToken);
   if(!token.success)throw new AndroidClockIntegrityError({status:'refused',reason:'invalid_proof'});
   const cancelled=()=>{if(signal?.aborted)throw new AndroidClockIntegrityError({status:'unavailable',reason:'provider_unavailable'});};
   const clock=createAndroidClockService(configuration,{
    beforeCommit:async tx=>{cancelled();await guard(tx);cancelled();},
    verifyCurrent:async(context,challenge)=>{
     const result=await verify(token.data,{clientData:context,challengeIssuedAt:Date.parse(challenge.issuedAt)},signal);
     if(result.status!=='eligible')throw new AndroidClockIntegrityError(result);
     const assessment=result.assessment;
     return {assessment,async assertFresh(tx,lockedContext){
      cancelled();
      if(assessment.clientDataHash!==onlineClockClientDataHash(lockedContext).toString('hex')||
       assessment.configurationDigest!==configurationDigest||assessment.policyDigest!==policyDigest)throw unavailable();
      const rows=await tx.execute(sql`select clock_timestamp() stamp`),raw=rows[0]?.stamp;
      const time=(raw instanceof Date?raw:new Date(String(raw))).getTime();
      if(!Number.isSafeInteger(time)||time<Date.parse(challenge.issuedAt)||assessment.checkedAt-time>p.allowedFutureSkewMs)
       throw new AndroidClockIntegrityError({status:'unavailable',reason:'time_unavailable'});
      if(time>=lockedContext.challenge.expiresAt)throw new AndroidClockIntegrityError({status:'refused',reason:'challenge_unavailable'});
      if(time-assessment.requestedAt>p.maxTokenAgeMs||assessment.requestedAt-time>p.allowedFutureSkewMs)
       throw new AndroidClockIntegrityError({status:'refused',reason:'stale_token'});
     }};
    },
   });
   return clock.complete(ctx,input,{challengeId:proof.challengeId,signature:proof.signature});
  },
 };
}
