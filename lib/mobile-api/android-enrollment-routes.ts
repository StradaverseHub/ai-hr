/** Unmounted Android enrollment boundary. Activation requires trusted configuration and the custody
 * schema; this factory never grants attendance trust or substitutes an Apple/Huawei proof. */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {createAndroidEnrollmentService,AndroidKeyEnrollmentError,IntegrityChallengeError,OwnClockEmploymentUnavailableError} from '../../packs/attendance/mobile-integrity';
import {AndroidEnrollmentSettings} from '../mobile-android-enrollment';
import * as C from '../mobile-integrity-contract';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {mobileInput} from './body';
import {integrityEmployment} from './integrity-request';
import {createIntegrityConfigurationReader,IntegrityConfigurationUnavailable,type IntegrityConfigurationReader} from './integrity-configuration';
import {AndroidKeyChainError} from './android-key-chain';
import {AndroidKeyPolicyError} from './android-key-policy';
type Refusal=z.infer<typeof C.IntegrityRefused>|z.infer<typeof C.IntegrityUnavailable>;
function expected(error:unknown):Refusal|undefined{
 if(error instanceof IntegrityConfigurationUnavailable)return {outcome:'unavailable',code:error.reason};
 if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable',code:'module_unavailable'};
 if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused',code:'subject_unavailable'};
 if(error instanceof IntegrityChallengeError)return error.reason==='time_unavailable'?{outcome:'unavailable',code:'proof_unavailable'}:
  {outcome:'refused',code:error.reason==='binding_conflict'?'binding_conflict':'challenge_unavailable'};
 if(error instanceof AndroidKeyEnrollmentError){
  if(error.reason==='configuration_unavailable')return {outcome:'unavailable',code:error.reason};
  return {outcome:'refused',code:error.reason==='capacity'?'key_limit':error.reason==='active_key_exists'?'key_exists':error.reason};
 }
 if(error instanceof AndroidKeyChainError){
  if(error.reason==='configuration'||error.reason==='revocation_unavailable')return {outcome:'unavailable',code:error.reason==='configuration'?'configuration_unavailable':'proof_unavailable'};
  return {outcome:'refused',code:'invalid_proof'};
 }
 if(error instanceof AndroidKeyPolicyError){
  if(error.reason==='configuration'||error.reason==='metadata_unavailable')return {outcome:'unavailable',code:error.reason==='configuration'?'configuration_unavailable':'metadata_unavailable'};
  return {outcome:'refused',code:'invalid_proof'};
 }
}
function parse<S extends z.ZodType>(schema:S,input:unknown):z.output<S>{
 const value=schema.safeParse(input);if(!value.success)throw new MobileBadRequest('Invalid enrollment command');return value.data;
}
export function createAndroidEnrollmentHttpHandlers(configuration:IntegrityConfigurationReader,resolve?:MobileSessionResolver,options:{configurationTimeoutMs?:number}={}){
 const settings=createIntegrityConfigurationReader(AndroidEnrollmentSettings,configuration,options.configurationTimeoutMs);
 function route<S extends z.ZodType>(schema:S,fn:(ctx:SessionContext,req:Request)=>Promise<unknown>){
  return mobileRoute(schema,async(ctx,req)=>{
   try{return await fn(ctx,req) as z.input<S>;}catch(error){const known=expected(error);if(known)return known as z.input<S>;throw error;}
  },resolve);
 }
 return {
  enrollmentBegin:route(C.IntegrityAndroidEnrollmentPrepared,async(ctx,req)=>{
   const employmentId=await integrityEmployment(ctx,req),input=parse(C.IntegrityEnrollmentIntent,await mobileInput(req,1024));
   const result=await createAndroidEnrollmentService(await settings(ctx,employmentId,req.signal)).begin(ctx,{...input,employmentId});
   return {outcome:'prepared',protocol:2,context:result.context,clientDataHash:result.clientDataHash,alias:result.alias,state:result.challenge.state};
  }),
  enrollmentComplete:route(C.IntegrityAndroidEnrollmentResult,async(ctx,req)=>{
   const employmentId=await integrityEmployment(ctx,req),{publicKeySpki,certificateChain,...input}=parse(C.IntegrityAndroidEnrollmentProof,await mobileInput(req,36*1024));
   const key=await createAndroidEnrollmentService(await settings(ctx,employmentId,req.signal)).complete(ctx,{...input,employmentId,
    publicKeySpki:Buffer.from(publicKeySpki,'base64'),certificateChain:certificateChain.map(value=>Buffer.from(value,'base64'))},req.signal);
   return {outcome:'enrolled',key};
  }),
 };
}
