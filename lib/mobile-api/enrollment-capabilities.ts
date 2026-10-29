/** Authenticated discovery does not issue a challenge or create a key. */
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {OwnClockEmploymentUnavailableError} from '../../packs/attendance/mobile-integrity-recovery';
import {AppleEnrollmentSettings} from '../mobile-key-enrollment';
import {AndroidEnrollmentSettings} from '../mobile-android-enrollment';
import {createIntegrityConfigurationReader,IntegrityConfigurationUnavailable,type IntegrityConfigurationReader} from './integrity-configuration';
import {integrityEmployment} from './integrity-request';
export function createEnrollmentCapabilitiesOperation(platform:'ios'|'android',configuration:IntegrityConfigurationReader){
 const settings=createIntegrityConfigurationReader(platform==='ios'?AppleEnrollmentSettings:AndroidEnrollmentSettings,configuration);
 return async(ctx:SessionContext,req:Request)=>{
  try{
   const id=await integrityEmployment(ctx,req);await settings(ctx,id,req.signal);
   return {outcome:'capabilities' as const,protocol:2 as const,platform,features:['key_enrollment'],offline:false as const};
  }catch(error){
   if(error instanceof IntegrityConfigurationUnavailable)return {outcome:'unavailable' as const,code:error.reason};
   if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable' as const,code:'module_unavailable' as const};
   if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused' as const,code:'subject_unavailable' as const};
   throw error;
  }
 };
}
