/** Enrollment uses deployment-gated route assembly; signed-clock handlers remain unmounted.
 * A trusted company/deployment configuration owner is supplied by server route assembly.
 * Never obtain that configuration, expected app identity or a verifier from request data/headers.
 */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {OwnClockEmploymentUnavailableError,createAppleEnrollmentService,AppleKeyEnrollmentError,IntegrityChallengeError} from '../../packs/attendance/mobile-integrity';
import {AppAttestEnrollmentError} from './app-attest-enrollment';
import {AppleEnrollmentSettings} from '../mobile-key-enrollment';
import * as C from '../mobile-integrity-contract';
import {mobileRoute,MobileBadRequest,type MobileSessionResolver} from './handler';
import {integrityEmployment as selected} from './integrity-request';
import {createIntegrityKeyOperations} from './integrity-key-routes';
import {mobileInput} from './body';
import {createSignedClockOperations,type SignedClockOptions} from './signed-clock-routes';
import {createIntegrityConfigurationReader,IntegrityConfigurationUnavailable,type EnrollmentCommitGuard} from './integrity-configuration';

type Refusal=z.infer<typeof C.IntegrityRefused>|z.infer<typeof C.IntegrityUnavailable>;
const unavailable=(code:z.infer<typeof C.IntegrityUnavailable>['code']):Refusal=>({outcome:'unavailable',code});
const refused=(code:z.infer<typeof C.IntegrityRefused>['code']):Refusal=>({outcome:'refused',code});
function expected(error:unknown):Refusal|undefined{
  if(error instanceof IntegrityConfigurationUnavailable)return unavailable(error.reason);
  if(error instanceof ModuleNotEnabledError)return unavailable('module_unavailable');
  if(error instanceof OwnClockEmploymentUnavailableError)return refused('subject_unavailable');
  if(error instanceof AppleKeyEnrollmentError){
    if(error.reason==='configuration_unavailable'||error.reason==='metadata_unavailable')return unavailable(error.reason);
    return refused(error.reason==='binding_conflict'?'binding_conflict':error.reason==='invalid_proof'?'invalid_proof':
      error.reason==='capacity'?'key_limit':error.reason==='active_key_exists'?'key_exists':'key_unavailable');
  }
  if(error instanceof IntegrityChallengeError)return error.reason==='time_unavailable'?unavailable('proof_unavailable'):
    refused(error.reason==='binding_conflict'?'binding_conflict':'challenge_unavailable');
  if(error instanceof AppAttestEnrollmentError)return error.reason==='invalid_configuration'?unavailable('configuration_unavailable'):
    error.reason==='metadata_unavailable'?unavailable('metadata_unavailable'):refused('invalid_proof');
}
function parse<S extends z.ZodType>(schema:S,raw:unknown):z.output<S>{
  const value=schema.safeParse(raw);if(!value.success)throw new MobileBadRequest('Invalid integrity command');return value.data;
}
function bytes(value:string,maximum:number){
  const decoded=Buffer.from(value,'base64');
  if(decoded.length<1||decoded.length>maximum||decoded.toString('base64')!==value)throw new MobileBadRequest('Invalid proof encoding');return decoded;
}
/** Session/configuration ports are server assembly/test seams, not HTTP fields. Settings are loaded
 * afresh after own-subject authorization; enrollment keys remain listable/revocable during outages.
 * Responses distinguish preparation/unavailability/refusal from acceptance. No handler falls back.
 */
export function createIntegrityOperations(configuration:(ctx:SessionContext,employmentId:string,signal:AbortSignal)=>Promise<unknown|null>,options:SignedClockOptions&{beforeEnrollmentCommit?:EnrollmentCommitGuard}={}){
  const settings=createIntegrityConfigurationReader(AppleEnrollmentSettings,configuration,options.configurationTimeoutMs);
  function route<S extends z.ZodType>(schema:S,fn:(ctx:SessionContext,req:Request)=>Promise<unknown>){
    return async(ctx:SessionContext,req:Request)=>{
      try{return await fn(ctx,req) as z.input<S>;}
      catch(error){const known=expected(error);if(known)return known as z.input<S>;throw error;}
    };
  }
  const clocks=createSignedClockOperations('ios',configuration,options);
  return {
    capabilities:route(C.IntegrityCapabilities,async(ctx,req)=>{
      const id=await selected(ctx,req);await settings(ctx,id,req.signal);
      return {outcome:'capabilities',protocol:1,platform:'ios',features:['key_enrollment',...(typeof options.beforeClockCommit==='function'?['online_clock_assertion']:[])],offline:false};
    }),
    enrollmentBegin:route(C.IntegrityEnrollmentPrepared,async(ctx,req)=>{
      const id=await selected(ctx,req),input=parse(C.IntegrityEnrollmentIntent,await mobileInput(req,1024));
      const result=await createAppleEnrollmentService(await settings(ctx,id,req.signal)).begin(ctx,{...input,employmentId:id});
      return {outcome:'prepared',protocol:1,context:result.context,clientDataHash:result.clientDataHash,alias:result.alias,state:result.challenge.state};
    }),
    enrollmentComplete:route(C.IntegrityEnrollmentResult,async(ctx,req)=>{
      const id=await selected(ctx,req),{attestation,...input}=parse(C.IntegrityEnrollmentProof,await mobileInput(req,96*1024));
      const config=await settings(ctx,id,req.signal);
      const key=await createAppleEnrollmentService(config,{beforeCommit:options.beforeEnrollmentCommit?async tx=>{
        if(req.signal.aborted)throw new IntegrityConfigurationUnavailable('configuration_unavailable');await options.beforeEnrollmentCommit!(tx,ctx,id,config);
      }:undefined}).complete(ctx,{...input,employmentId:id,attestation:bytes(attestation,65536)});
      return {outcome:'enrolled',key};
    }),
    ...createIntegrityKeyOperations(),
    clockBegin:clocks.clockBegin,
    clockComplete:clocks.clockComplete,
  };
}
export function createIntegrityHttpHandlers(configuration:(ctx:SessionContext,employmentId:string,signal:AbortSignal)=>Promise<unknown|null>,resolve?:MobileSessionResolver,options:SignedClockOptions&{beforeEnrollmentCommit?:EnrollmentCommitGuard}={}){
 const operations=createIntegrityOperations(configuration,options);
 return {
  capabilities:mobileRoute(C.IntegrityCapabilities,operations.capabilities,resolve),
  enrollmentBegin:mobileRoute(C.IntegrityEnrollmentPrepared,operations.enrollmentBegin,resolve),
  enrollmentComplete:mobileRoute(C.IntegrityEnrollmentResult,operations.enrollmentComplete,resolve),
  keys:mobileRoute(C.IntegrityKeysResult,async(ctx,req)=>C.IntegrityKeysResult.parse(await operations.keys(ctx,req)),resolve),
  keyReceipt:mobileRoute(C.IntegrityKeyLookupResult,async(ctx,req)=>C.IntegrityKeyLookupResult.parse(await operations.keyReceipt(ctx,req)),resolve),
  revoke:mobileRoute(C.IntegrityRevocationResult,async(ctx,req)=>C.IntegrityRevocationResult.parse(await operations.revoke(ctx,req)),resolve),
  clockBegin:mobileRoute(C.IntegrityClockPrepared,async(ctx,req)=>C.IntegrityClockPrepared.parse(await operations.clockBegin(ctx,req)),resolve),
  clockComplete:mobileRoute(C.IntegrityClockResult,async(ctx,req)=>C.IntegrityClockResult.parse(await operations.clockComplete(ctx,req)),resolve),
 };
}
