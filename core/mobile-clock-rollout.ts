/** Trusted signed-clock assembly. Enrollment rollout and current clock rollout are independent. */
import 'server-only';
import type {SessionContext,Tx} from '../db/client';
import {IntegrityConfigurationUnavailable} from '../lib/mobile-api/integrity-configuration';
import {isSecretStorable} from '../lib/ai/crypto';
import {assertModuleEnabled} from './entitlements';
import {ownIntegrityEnrollmentCompany,ownIntegrityEnrollmentCompanyTx} from './mobile-integrity-key';
import {isMobileIntegrityStorageReady} from './mobile-enrollment-rollout';
import {mobileClockRolloutEntry,ClockPolicyUnavailableError} from './mobile-clock-policy';
type Platform='ios'|'android';
const unavailable=()=>new IntegrityConfigurationUnavailable('configuration_unavailable');
function configured(platform:Platform,ctx:SessionContext,companyId:string){
 try{return mobileClockRolloutEntry(ctx,companyId)?.platforms[platform]??null;}
 catch(error){if(error instanceof ClockPolicyUnavailableError)throw unavailable();throw error;}
}
/** All metadata comes from the deployment policy after temporal own-company proof. The project
 * number is public SDK configuration, not an access credential or evidence of vendor readiness. */
export async function readMobileClockDeployment(platform:Platform,ctx:SessionContext,employmentId:string,signal:AbortSignal){
 if(signal.aborted)throw unavailable();
 const companyId=await ownIntegrityEnrollmentCompany(ctx,employmentId);if(signal.aborted)throw unavailable();
 if(!companyId)return null;
 assertModuleEnabled(ctx,'attendance',companyId);
 const deployment=configured(platform,ctx,companyId);if(!deployment)return null;
 if(!isSecretStorable()||!await isMobileIntegrityStorageReady(ctx,platform)||signal.aborted)throw unavailable();
 return deployment;
}
export async function readMobileClockConfiguration(platform:Platform,ctx:SessionContext,employmentId:string,signal:AbortSignal){
 return (await readMobileClockDeployment(platform,ctx,employmentId,signal))?.configuration??null;
}
/** No pooled reads under held proof/key/attendance locks. The temporal company and exact current
 * settings/policy are read again using the caller's transaction after tentative attendance work. */
export async function assertMobileClockCommit(tx:Tx,ctx:SessionContext,employmentId:string,initial:unknown){
 const companyId=await ownIntegrityEnrollmentCompanyTx(tx,ctx,employmentId);if(!companyId)throw unavailable();
 assertModuleEnabled(ctx,'attendance',companyId);
 const platform=(initial as {target?:{platform?:unknown};settings?:{target?:{platform?:unknown}}})?.settings?.target?.platform??
  (initial as {target?:{platform?:unknown}})?.target?.platform;
 if(platform!=='ios'&&platform!=='android')throw unavailable();
 const current=configured(platform,ctx,companyId);
 if(!current)throw new IntegrityConfigurationUnavailable('not_configured');
 if(!isSecretStorable())throw unavailable();
}
