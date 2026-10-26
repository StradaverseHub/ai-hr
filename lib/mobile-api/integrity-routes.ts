/** HTTP handlers for the reviewed integrity protocol; no filesystem route activates them yet.
 * A trusted company/deployment configuration owner must be supplied by the eventual route assembly.
 * Never obtain that configuration, expected app identity or a verifier from request data/headers.
 */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {withAttendanceTenant} from '../../core/module-gate';
import {myOwnEmploymentSubjectsTx} from '../../core/read';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {OwnClockEmploymentUnavailableError,createAppleEnrollmentService,listOwnIntegrityKeys,revokeOwnIntegrityKey,AppleKeyEnrollmentError,
  createAppleClockService,AppleClockAssertionError,IntegrityChallengeError,ClockConflictError,CorrectedClockConflictError,
  ClockLocationError,AttendancePhotoRequiredError,OutsideGeofenceError,GeolocationRequiredError,GeofenceQualityError,DeviceNotRegisteredError} from '../../packs/attendance/service';
import {ClockPhotoError} from '../attendance-photo';
import {AppAttestEnrollmentError} from './app-attest-enrollment';
import {AppAttestAssertionError} from './app-attest-assertion';
import {AppleEnrollmentSettings} from '../mobile-key-enrollment';
import * as C from '../mobile-integrity-contract';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {mobileInput,mobileForm} from './body';

class NotConfigured extends Error{}
type Refusal=z.infer<typeof C.IntegrityRefused>|z.infer<typeof C.IntegrityUnavailable>;
const unavailable=(code:z.infer<typeof C.IntegrityUnavailable>['code']):Refusal=>({outcome:'unavailable',code});
const refused=(code:z.infer<typeof C.IntegrityRefused>['code']):Refusal=>({outcome:'refused',code});
function expected(error:unknown):Refusal|undefined{
  if(error instanceof NotConfigured)return unavailable('not_configured');
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
  if(error instanceof OutsideGeofenceError)return refused('outside_geofence');
  if(error instanceof ClockLocationError||error instanceof GeolocationRequiredError||error instanceof GeofenceQualityError)return refused('location_required');
  if(error instanceof DeviceNotRegisteredError)return refused('device_required');
  if(error instanceof ClockPhotoError)return refused('photo_invalid');
}
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
async function selected(ctx:SessionContext,req:Request){
  const params=new URL(req.url).searchParams;
  if([...params.keys()].some(key=>key!=='employmentId')||params.getAll('employmentId').length!==1)throw new MobileBadRequest('Select an employment');
  const parsed=uuid.safeParse(params.get('employmentId'));if(!parsed.success)throw new MobileBadRequest('Invalid selector');
  const own=await withAttendanceTenant(ctx,tx=>myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true}));
  if(!ctx.userId||!ctx.personId||!own.some(row=>row.employmentId===parsed.data))throw new OwnClockEmploymentUnavailableError();
  return parsed.data;
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
export function createIntegrityHttpHandlers(configuration:(ctx:SessionContext,employmentId:string)=>Promise<unknown|null>,resolve?:MobileSessionResolver){
  async function settings(ctx:SessionContext,id:string){
    const raw=await configuration(ctx,id);if(raw===null)throw new NotConfigured();
    const parsed=AppleEnrollmentSettings.safeParse(raw);if(!parsed.success)throw new AppleKeyEnrollmentError('configuration_unavailable');return parsed.data;
  }
  function route<S extends z.ZodType>(schema:S,fn:(ctx:SessionContext,req:Request)=>Promise<unknown>){
    return mobileRoute(schema,async(ctx,req)=>{
      try{return await fn(ctx,req) as z.input<S>;}
      catch(error){const known=expected(error);if(known)return known as z.input<S>;throw error;}
    },resolve);
  }
  return {
    capabilities:route(C.IntegrityCapabilities,async(ctx,req)=>{
      const id=await selected(ctx,req);await settings(ctx,id);
      return {outcome:'capabilities',protocol:1,platform:'ios',features:['key_enrollment','online_clock_assertion'],offline:false};
    }),
    enrollmentBegin:route(C.IntegrityEnrollmentPrepared,async(ctx,req)=>{
      const id=await selected(ctx,req),input=parse(C.IntegrityEnrollmentIntent,await mobileInput(req,1024));
      const result=await createAppleEnrollmentService(await settings(ctx,id)).begin(ctx,{...input,employmentId:id});
      return {outcome:'prepared',protocol:1,context:result.context,clientDataHash:result.clientDataHash,alias:result.alias,state:result.challenge.state};
    }),
    enrollmentComplete:route(C.IntegrityEnrollmentResult,async(ctx,req)=>{
      const id=await selected(ctx,req),{attestation,...input}=parse(C.IntegrityEnrollmentProof,await mobileInput(req,96*1024));
      const key=await createAppleEnrollmentService(await settings(ctx,id)).complete(ctx,{...input,employmentId:id,attestation:bytes(attestation,65536)});
      return {outcome:'enrolled',key};
    }),
    keys:route(C.IntegrityKeysResult,async(ctx,req)=>({outcome:'keys',items:await listOwnIntegrityKeys(ctx,await selected(ctx,req))})),
    revoke:route(C.IntegrityRevocationResult,async(ctx,req)=>{
      const id=await selected(ctx,req),input=parse(C.IntegrityRevokeIntent,await mobileInput(req,256));
      return {outcome:'revoked',key:await revokeOwnIntegrityKey(ctx,{...input,employmentId:id})};
    }),
    clockBegin:route(C.IntegrityClockPrepared,async(ctx,req)=>{
      const id=await selected(ctx,req),{command,...photo}=await form(req,C.IntegrityClockIntent);
      const result=await createAppleClockService(await settings(ctx,id)).begin(ctx,{...command,...photo,employmentId:id});
      return {outcome:'prepared',protocol:1,context:result.context,state:result.challenge.state};
    }),
    clockComplete:route(C.IntegrityClockResult,async(ctx,req)=>{
      const id=await selected(ctx,req),{command:{challengeId,assertion,...command},...photo}=await form(req,C.IntegrityClockProof);
      const receipt=await createAppleClockService(await settings(ctx,id)).complete(ctx,{...command,...photo,employmentId:id},{challengeId,assertion:bytes(assertion,8192)});
      return {outcome:'accepted',receipt};
    }),
  };
}
