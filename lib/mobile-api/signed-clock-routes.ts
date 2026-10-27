/** Unmounted signed-clock HTTP boundary. Enrollment permission alone never activates this protocol. */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {createAppleClockService,createAndroidVerifiedClockService,AndroidClockIntegrityError,AppleClockAssertionError,AndroidClockCommandError,
 IntegrityChallengeError,OwnClockEmploymentUnavailableError,ClockConflictError,CorrectedClockConflictError,
 ClockLocationError,AttendancePhotoRequiredError,OutsideGeofenceError,GeolocationRequiredError,GeofenceQualityError,DeviceNotRegisteredError} from '../../packs/attendance/mobile-integrity';
import {ClockPhotoError} from '../attendance-photo';
import {AppleEnrollmentSettings} from '../mobile-key-enrollment';
import {AndroidClockConfiguration} from '../mobile-android-clock-policy';
import type {PlayAccessTokenProvider} from './play-integrity';
import * as C from '../mobile-integrity-contract';
import {AppAttestAssertionError} from './app-attest-assertion';
import {AndroidClockSignatureError} from './android-clock-signature';
import {createIntegrityConfigurationReader,IntegrityConfigurationUnavailable,type IntegrityConfigurationReader,type ClockCommitGuard} from './integrity-configuration';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {integrityEmployment} from './integrity-request';
import {mobileForm} from './body';
type Refusal=z.infer<typeof C.IntegrityRefused>|z.infer<typeof C.IntegrityUnavailable>;
function expected(error:unknown):Refusal|undefined{
 if(error instanceof AndroidClockIntegrityError){
  const result=error.result;
  return result.status==='unavailable'?{outcome:'unavailable',code:result.reason==='configuration_unavailable'?'configuration_unavailable':'proof_unavailable',integrityReason:result.reason}:
   {outcome:'refused',code:result.reason==='challenge_unavailable'?'challenge_unavailable':'invalid_proof',integrityReason:result.reason};
 }
 if(error instanceof IntegrityConfigurationUnavailable)return {outcome:'unavailable',code:error.reason};
 if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable',code:'module_unavailable'};
 if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused',code:'subject_unavailable'};
 if(error instanceof IntegrityChallengeError)return error.reason==='time_unavailable'?{outcome:'unavailable',code:'proof_unavailable'}:{outcome:'refused',code:error.reason==='binding_conflict'?'binding_conflict':'challenge_unavailable'};
 if(error instanceof AppleClockAssertionError||error instanceof AndroidClockCommandError){
  if(error.reason==='configuration_unavailable')return {outcome:'unavailable',code:'configuration_unavailable'};
  if(error.reason==='time_unavailable'||error.reason==='counter_unavailable')return {outcome:'unavailable',code:'proof_unavailable'};
  return {outcome:'refused',code:error.reason==='key_unavailable'?'key_unavailable':error.reason==='expired'?'challenge_unavailable':'invalid_proof'};
 }
 if(error instanceof AppAttestAssertionError){if(error.reason==='invalid_configuration')return {outcome:'unavailable',code:'configuration_unavailable'};if(error.reason!=='invalid_key')return {outcome:'refused',code:'invalid_proof'};}
 if(error instanceof AndroidClockSignatureError){if(error.reason==='configuration')return {outcome:'unavailable',code:'configuration_unavailable'};if(error.reason!=='invalid_key')return {outcome:'refused',code:'invalid_proof'};}
 if(error instanceof CorrectedClockConflictError)return {outcome:'refused',code:'corrected_day'};
 if(error instanceof ClockConflictError)return {outcome:'refused',code:'clock_conflict'};
 if(error instanceof AttendancePhotoRequiredError)return {outcome:'refused',code:'photo_required'};
 if(error instanceof GeofenceQualityError)return {outcome:'refused',code:'location_required',locationReason:error.assessment.outcome==='poor_accuracy'?'poor_accuracy':error.assessment.outcome==='invalid_location'?'invalid_location':'location_required'};
 if(error instanceof OutsideGeofenceError)return {outcome:'refused',code:'outside_geofence',...(error.info.reason?{locationReason:error.info.reason}:{})};
 if(error instanceof ClockLocationError||error instanceof GeolocationRequiredError)return {outcome:'refused',code:'location_required'};
 if(error instanceof DeviceNotRegisteredError)return {outcome:'refused',code:'device_required'};
 if(error instanceof ClockPhotoError)return {outcome:'refused',code:'photo_invalid'};
}
async function form<S extends z.ZodType>(req:Request,schema:S,playToken=false){
 const fields=await mobileForm(req,playToken?['command','photo','playIntegrityToken']:['command','photo'],3*1024*1024),raw=fields.get('command'),file=fields.get('photo');
 const token=playToken?C.IntegrityAndroidClockToken.safeParse(fields.get('playIntegrityToken')):undefined;
 if(token&&!token.success)throw new MobileBadRequest('Invalid integrity token');
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>16384)throw new MobileBadRequest('Invalid command');
 let json:unknown;try{json=JSON.parse(raw);}catch{throw new MobileBadRequest('Invalid JSON');}
 const parsed=schema.safeParse(json);if(!parsed.success)throw new MobileBadRequest('Invalid integrity command');
 if(file!==null&&(!(file instanceof File)||file.size<1||file.size>2*1024*1024||!['image/jpeg','image/png'].includes(file.type)))throw new MobileBadRequest('Invalid photo');
 return {command:parsed.data,...(token?.success?{playIntegrityToken:token.data}:{}),...(file instanceof File?{photo:Buffer.from(await file.arrayBuffer()),mime:file.type as 'image/jpeg'|'image/png'}:{})};
}
function bytes(encoded:string,maximum:number){const value=Buffer.from(encoded,'base64');if(value.length<1||value.length>maximum||value.toString('base64')!==encoded)throw new MobileBadRequest('Invalid proof encoding');return value;}
export type SignedClockOptions={configurationTimeoutMs?:number;beforeClockCommit?:ClockCommitGuard;
 /** Server-owned Google credentials and transport; never selected by request fields. */
 androidPlay?:{accessToken:PlayAccessTokenProvider|null;transport?:typeof fetch;timeoutMs?:number}};
/** The trusted guard revalidates rollout/policy using the supplied transaction, after attendance work.
 * Absence refuses both preparation and completion. Never call a pooled configuration reader from
 * inside this guard; the route assembly must provide the transaction-aware policy owner. */
export function createSignedClockOperations(platform:'ios'|'android',configuration:IntegrityConfigurationReader,options:SignedClockOptions={}){
 const settings=createIntegrityConfigurationReader(z.union([AppleEnrollmentSettings,AndroidClockConfiguration]),configuration,options.configurationTimeoutMs);
 async function configured(ctx:SessionContext,id:string,req:Request){
  if(typeof options.beforeClockCommit!=='function')throw new IntegrityConfigurationUnavailable('configuration_unavailable');
  const config=await settings(ctx,id,req.signal);if(('settings' in config?'android':'ios')!==platform)throw new IntegrityConfigurationUnavailable('configuration_unavailable');return config;
 }
 function commit(ctx:SessionContext,id:string,config:unknown,req:Request){return async(tx:Parameters<ClockCommitGuard>[0])=>{
  if(req.signal.aborted)throw new IntegrityConfigurationUnavailable('configuration_unavailable');
  await options.beforeClockCommit!(tx,ctx,id,config);
  if(req.signal.aborted)throw new IntegrityConfigurationUnavailable('configuration_unavailable');
 };}
 function android(ctx:SessionContext,id:string,config:z.infer<typeof AndroidClockConfiguration>,req:Request){
  return createAndroidVerifiedClockService(config.settings,config.policy,options.androidPlay?.accessToken??null,{
   transport:options.androidPlay?.transport,timeoutMs:options.androidPlay?.timeoutMs,beforeCommit:commit(ctx,id,config,req),
  });
 }
 function route(fn:(ctx:SessionContext,req:Request)=>Promise<unknown>){return async(ctx:SessionContext,req:Request)=>{try{return await fn(ctx,req);}catch(error){const known=expected(error);if(known)return known;throw error;}};}
 return {
  clockBegin:route(async(ctx,req)=>{
   const id=await integrityEmployment(ctx,req),{command,...photo}=await form(req,platform==='ios'?C.IntegrityClockIntent:C.IntegrityAndroidClockIntent),config=await configured(ctx,id,req);
   const service='settings' in config?android(ctx,id,config,req):createAppleClockService(config);
   const result=await service.begin(ctx,{...command,...photo,employmentId:id});
   return {outcome:'prepared',protocol:platform==='ios'?1:2,context:result.context,state:result.challenge.state};
  }),
  clockComplete:route(async(ctx,req)=>{
   const id=await integrityEmployment(ctx,req);
   if(platform==='ios'){
    const {command:{challengeId,assertion,...command},...photo}=await form(req,C.IntegrityClockProof),config=await configured(ctx,id,req);
    const receipt=await createAppleClockService(config,{beforeCommit:commit(ctx,id,config,req)}).complete(ctx,{...command,...photo,employmentId:id},{challengeId,assertion:bytes(assertion,8192)});
    return {outcome:'accepted',receipt};
   }
   const {command:{challengeId,signature,...command},playIntegrityToken,...photo}=await form(req,C.IntegrityAndroidClockProof,true),config=await configured(ctx,id,req);
   if(!('settings' in config))throw new IntegrityConfigurationUnavailable('configuration_unavailable');
   const receipt=await android(ctx,id,config,req).complete(ctx,{...command,...photo,employmentId:id},{challengeId,signature:bytes(signature,72),playIntegrityToken:playIntegrityToken!},req.signal);
   return {outcome:'accepted',receipt};
  }),
 };
}
export function createSignedClockHttpHandlers(platform:'ios'|'android',configuration:IntegrityConfigurationReader,resolve?:MobileSessionResolver,options:SignedClockOptions={}){
 const operations=createSignedClockOperations(platform,configuration,options);
 const prepared=platform==='ios'?C.IntegrityClockPrepared:C.IntegrityAndroidClockPrepared;
 return {clockBegin:mobileRoute(prepared,async(ctx,req)=>prepared.parse(await operations.clockBegin(ctx,req)),resolve),
  clockComplete:mobileRoute(C.IntegrityClockResult,async(ctx,req)=>C.IntegrityClockResult.parse(await operations.clockComplete(ctx,req)),resolve)};
}
