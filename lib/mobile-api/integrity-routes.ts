/** Enrollment and signed-clock HTTP handlers remain unmounted; key recovery has separate routes.
 * A trusted company/deployment configuration owner must be supplied by the eventual route assembly.
 * Never obtain that configuration, expected app identity or a verifier from request data/headers.
 */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {OwnClockEmploymentUnavailableError,createAppleEnrollmentService,AppleKeyEnrollmentError,
  createAppleClockService,AppleClockAssertionError,IntegrityChallengeError,ClockConflictError,CorrectedClockConflictError,
  ClockLocationError,AttendancePhotoRequiredError,OutsideGeofenceError,GeolocationRequiredError,GeofenceQualityError,DeviceNotRegisteredError} from '../../packs/attendance/mobile-integrity';
import {ClockPhotoError} from '../attendance-photo';
import {AppAttestEnrollmentError} from './app-attest-enrollment';
import {AppAttestAssertionError} from './app-attest-assertion';
import {AppleEnrollmentSettings} from '../mobile-key-enrollment';
import * as C from '../mobile-integrity-contract';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {integrityEmployment as selected} from './integrity-request';
import {createIntegrityKeyHttpHandlers} from './integrity-key-routes';
import {mobileInput,mobileForm} from './body';

class NotConfigured extends Error{}
class ConfigurationReadUnavailable extends Error{}
type Refusal=z.infer<typeof C.IntegrityRefused>|z.infer<typeof C.IntegrityUnavailable>;
const unavailable=(code:z.infer<typeof C.IntegrityUnavailable>['code']):Refusal=>({outcome:'unavailable',code});
const refused=(code:z.infer<typeof C.IntegrityRefused>['code']):Refusal=>({outcome:'refused',code});
function expected(error:unknown):Refusal|undefined{
  if(error instanceof NotConfigured)return unavailable('not_configured');
  if(error instanceof ConfigurationReadUnavailable)return unavailable('configuration_unavailable');
  if(error instanceof ModuleNotEnabledError)return unavailable('module_unavailable');
  if(error instanceof OwnClockEmploymentUnavailableError)return refused('subject_unavailable');
  if(error instanceof AppleKeyEnrollmentError){
    if(error.reason==='configuration_unavailable'||error.reason==='metadata_unavailable')return unavailable(error.reason);
    return refused(error.reason==='binding_conflict'?'binding_conflict':error.reason==='invalid_proof'?'invalid_proof':
      error.reason==='capacity'?'key_limit':error.reason==='active_key_exists'?'key_exists':'key_unavailable');
  }
  if(error instanceof IntegrityChallengeError)return error.reason==='time_unavailable'?unavailable('proof_unavailable'):
    refused(error.reason==='binding_conflict'?'binding_conflict':'challenge_unavailable');
  if(error instanceof AppleClockAssertionError)return error.reason==='configuration_unavailable'?unavailable('configuration_unavailable'):
    error.reason==='counter_unavailable'||error.reason==='time_unavailable'?unavailable('proof_unavailable'):
      refused(error.reason==='key_unavailable'?'key_unavailable':error.reason==='expired'?'challenge_unavailable':'invalid_proof');
  if(error instanceof AppAttestEnrollmentError)return error.reason==='invalid_configuration'?unavailable('configuration_unavailable'):
    error.reason==='metadata_unavailable'?unavailable('metadata_unavailable'):refused('invalid_proof');
  if(error instanceof AppAttestAssertionError){
    if(error.reason==='invalid_configuration')return unavailable('configuration_unavailable');
    if(error.reason!=='invalid_key')return refused('invalid_proof'); // Corrupt stored keys remain unexpected failures.
  }
  if(error instanceof CorrectedClockConflictError)return refused('corrected_day');
  if(error instanceof ClockConflictError)return refused('clock_conflict');
  if(error instanceof AttendancePhotoRequiredError)return refused('photo_required');
  if(error instanceof GeofenceQualityError)return {outcome:'refused',code:'location_required',locationReason:error.assessment.outcome==='poor_accuracy'?'poor_accuracy':error.assessment.outcome==='invalid_location'?'invalid_location':'location_required'};
  if(error instanceof OutsideGeofenceError)return {outcome:'refused',code:'outside_geofence',...(error.info.reason?{locationReason:error.info.reason}:{})};
  if(error instanceof ClockLocationError||error instanceof GeolocationRequiredError||error instanceof GeofenceQualityError)return refused('location_required');
  if(error instanceof DeviceNotRegisteredError)return refused('device_required');
  if(error instanceof ClockPhotoError)return refused('photo_invalid');
}
function parse<S extends z.ZodType>(schema:S,raw:unknown):z.output<S>{
  const value=schema.safeParse(raw);if(!value.success)throw new MobileBadRequest('Invalid integrity command');return value.data;
}
function bytes(value:string,maximum:number){
  const decoded=Buffer.from(value,'base64');
  if(decoded.length<1||decoded.length>maximum||decoded.toString('base64')!==value)throw new MobileBadRequest('Invalid proof encoding');return decoded;
}
async function form<S extends z.ZodType>(req:Request,schema:S){
  const fields=await mobileForm(req,['command','photo'],3*1024*1024),raw=fields.get('command'),file=fields.get('photo');
  if(typeof raw!=='string')throw new MobileBadRequest('Invalid command');
  let json:unknown;try{json=JSON.parse(raw);}catch{throw new MobileBadRequest('Invalid JSON');}
  const command=parse(schema,json);
  if(file!==null&&(!(file instanceof File)||file.size<1||file.size>2*1024*1024||!['image/jpeg','image/png'].includes(file.type)))throw new MobileBadRequest('Invalid photo');
  return {command,...(file instanceof File?{photo:Buffer.from(await file.arrayBuffer()),mime:file.type as 'image/jpeg'|'image/png'}:{})};
}
/** Session/configuration ports are server assembly/test seams, not HTTP fields. Settings are loaded
 * afresh after own-subject authorization; enrollment keys remain listable/revocable during outages.
 * Responses distinguish preparation/unavailability/refusal from acceptance. No handler falls back.
 */
export function createIntegrityHttpHandlers(configuration:(ctx:SessionContext,employmentId:string,signal:AbortSignal)=>Promise<unknown|null>,resolve?:MobileSessionResolver,options:{configurationTimeoutMs?:number}={}){
  const timeout=options.configurationTimeoutMs??3000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>10000)throw new Error('Invalid configuration deadline');
  async function settings(ctx:SessionContext,id:string,signal:AbortSignal){
    if(signal.aborted)throw new ConfigurationReadUnavailable();
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
    const stopped=new Promise<never>((_,reject)=>{
      abort=()=>{controller.abort();reject(new ConfigurationReadUnavailable());};
      signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeout);
    });
    try{
      const reading=Promise.resolve().then(()=>{
        if(controller.signal.aborted)throw new ConfigurationReadUnavailable();return configuration(ctx,id,controller.signal);
      });
      const raw=await Promise.race([reading,stopped]);
      if(controller.signal.aborted||signal.aborted)throw new ConfigurationReadUnavailable();
      if(raw===null)throw new NotConfigured();
      const parsed=AppleEnrollmentSettings.safeParse(raw);if(!parsed.success)throw new AppleKeyEnrollmentError('configuration_unavailable');return parsed.data;
    }catch(error){
      if(controller.signal.aborted||signal.aborted)throw new ConfigurationReadUnavailable();
      throw error;
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
  }
  function route<S extends z.ZodType>(schema:S,fn:(ctx:SessionContext,req:Request)=>Promise<unknown>){
    return mobileRoute(schema,async(ctx,req)=>{
      try{return await fn(ctx,req) as z.input<S>;}
      catch(error){const known=expected(error);if(known)return known as z.input<S>;throw error;}
    },resolve);
  }
  return {
    capabilities:route(C.IntegrityCapabilities,async(ctx,req)=>{
      const id=await selected(ctx,req);await settings(ctx,id,req.signal);
      return {outcome:'capabilities',protocol:1,platform:'ios',features:['key_enrollment','online_clock_assertion'],offline:false};
    }),
    enrollmentBegin:route(C.IntegrityEnrollmentPrepared,async(ctx,req)=>{
      const id=await selected(ctx,req),input=parse(C.IntegrityEnrollmentIntent,await mobileInput(req,1024));
      const result=await createAppleEnrollmentService(await settings(ctx,id,req.signal)).begin(ctx,{...input,employmentId:id});
      return {outcome:'prepared',protocol:1,context:result.context,clientDataHash:result.clientDataHash,alias:result.alias,state:result.challenge.state};
    }),
    enrollmentComplete:route(C.IntegrityEnrollmentResult,async(ctx,req)=>{
      const id=await selected(ctx,req),{attestation,...input}=parse(C.IntegrityEnrollmentProof,await mobileInput(req,96*1024));
      const key=await createAppleEnrollmentService(await settings(ctx,id,req.signal)).complete(ctx,{...input,employmentId:id,attestation:bytes(attestation,65536)});
      return {outcome:'enrolled',key};
    }),
    ...createIntegrityKeyHttpHandlers(resolve),
    clockBegin:route(C.IntegrityClockPrepared,async(ctx,req)=>{
      const id=await selected(ctx,req),{command,...photo}=await form(req,C.IntegrityClockIntent);
      const result=await createAppleClockService(await settings(ctx,id,req.signal)).begin(ctx,{...command,...photo,employmentId:id});
      return {outcome:'prepared',protocol:1,context:result.context,state:result.challenge.state};
    }),
    clockComplete:route(C.IntegrityClockResult,async(ctx,req)=>{
      const id=await selected(ctx,req),{command:{challengeId,assertion,...command},...photo}=await form(req,C.IntegrityClockProof);
      const receipt=await createAppleClockService(await settings(ctx,id,req.signal)).complete(ctx,{...command,...photo,employmentId:id},{challengeId,assertion:bytes(assertion,8192)});
      return {outcome:'accepted',receipt};
    }),
  };
}
