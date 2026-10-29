/** Default-closed route assembly. Clock and enrollment deployment permission remain separate. */
import 'server-only';
import type {SessionContext} from '../../db/client';
import {readMobileClockConfiguration,readMobileClockDeployment,assertMobileClockCommit,OwnClockEmploymentUnavailableError} from '../../packs/attendance/mobile-integrity';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {MobileClockDeployment} from '../mobile-clock-rollout-policy';
import {createSignedClockOperations} from './signed-clock-routes';
import {createIntegrityConfigurationReader,IntegrityConfigurationUnavailable} from './integrity-configuration';
import {readDeployedPlayCredentials} from './play-credentials';
import {integrityEmployment} from './integrity-request';
type Platform='ios'|'android';
/** The lazy Android assembly is evaluated only after request/subject/configuration validation. */
export function createDeployedSignedClockOperations(platform:Platform){
 return createSignedClockOperations(platform,(ctx,id,signal)=>readMobileClockConfiguration(platform,ctx,id,signal),{
  beforeClockCommit:assertMobileClockCommit,androidPlay:readDeployedPlayCredentials,
 });
}
export function createDeployedClockCapabilitiesOperation(platform:Platform){
 const deployment=createIntegrityConfigurationReader(MobileClockDeployment,(ctx,id,signal)=>readMobileClockDeployment(platform,ctx,id,signal));
 return async(ctx:SessionContext,req:Request)=>{
  try{
   const id=await integrityEmployment(ctx,req),value=await deployment(ctx,id,req.signal);
   if(platform==='android'){
    if(!('cloudProjectNumber' in value)||!readDeployedPlayCredentials().accessToken)throw new IntegrityConfigurationUnavailable('configuration_unavailable');
    return {outcome:'capabilities' as const,protocol:2 as const,platform:'android' as const,commandProtocol:2 as const,
     features:['online_clock_signature','current_play_integrity'] as ['online_clock_signature','current_play_integrity'],offline:false as const,cloudProjectNumber:value.cloudProjectNumber};
   }
   if('cloudProjectNumber' in value)throw new IntegrityConfigurationUnavailable('configuration_unavailable');
   return {outcome:'capabilities' as const,protocol:2 as const,platform:'ios' as const,commandProtocol:1 as const,
    features:['online_clock_assertion'] as ['online_clock_assertion'],offline:false as const,cloudProjectNumber:null};
  }catch(error){
   if(error instanceof IntegrityConfigurationUnavailable)return {outcome:'unavailable' as const,code:error.reason};
   if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable' as const,code:'module_unavailable' as const};
   if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused' as const,code:'subject_unavailable' as const};
   throw error;
  }
 };
}
