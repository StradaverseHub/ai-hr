/** Default-closed offline-clock assembly. UNMOUNTED: no route uses it yet (the transport is later work). Services are
 * built per request from the current deployment; nothing is cached. Without AIHR_MOBILE_OFFLINE_POLICY every
 * operation answers {outcome:'unavailable',code:'not_configured'} before any database or snapshot work. */
import 'server-only';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {ownIntegrityEnrollmentCompany} from '../../core/mobile-integrity-key';
import {createOfflineContextIssueService,closeOwnOfflineContext,OfflineContextIssueError,OfflineContextCloseError,type OfflineContextIssuePorts} from '../../core/mobile-offline-context';
import {createOfflineClaimService,OfflineClaimError,type OfflineClaimPhoto} from '../../core/mobile-offline-claim';
import {OfflineClockStreamError} from '../../core/mobile-offline-lease';
import {readMobileOfflineDeployment,assertOfflineIssueCommit,assertOfflineClaimCommit,ownOfflineContextCompany,isMobileOfflineDeploymentPresent,OfflineIssuanceDrainingError,type MobileOfflineDeployment} from '../../core/mobile-offline-rollout';
import {createOfflineAdjudicator,OfflineAdjudicationError,OwnClockEmploymentUnavailableError} from '../../packs/attendance/service';
import {RequestBudgetExceeded} from '../request-budget';
import {IntegrityConfigurationUnavailable} from './integrity-configuration';
type Platform='ios'|'android';
type Snapshot=OfflineContextIssuePorts['snapshot'];
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const notConfigured={outcome:'unavailable',code:'not_configured'} as const;
const field=(value:unknown,...path:string[])=>path.reduce<unknown>((at,key)=>at&&typeof at==='object'?Reflect.get(at,key):undefined,value);
/** Deployment-owned facts replace whatever the snapshot owner supplies for them: the window and permit count (this
 * deployment) and the app target (the clock rollout entry). Policy, sites and attendance stay the snapshot's. The same
 * composition feeds issuance and the adjudicator, so drift is measured against identical values. A port built by
 * offlineClockSnapshotPort(deployment) from these same values is unchanged by it; any other port cannot diverge. */
function deploymentSnapshot(snapshot:Snapshot,d:MobileOfflineDeployment):Snapshot{
 return async(tx,ctx,subject)=>{
  const value=await snapshot(tx,ctx,subject),policy=field(value,'policy');
  if(!value||typeof value!=='object'||Array.isArray(value)||!policy||typeof policy!=='object'||Array.isArray(policy))return value;
  return {...value,policy:{...policy,windowMs:d.windowMs},target:{...d.target},permitCount:d.permitCount};
 };
}
function failure(error:unknown){
 if(error instanceof IntegrityConfigurationUnavailable)return {outcome:'unavailable',code:error.reason} as const;
 if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable',code:'module_unavailable'} as const;
 if(error instanceof OfflineIssuanceDrainingError)return {outcome:'unavailable',code:'draining'} as const;
 if(error instanceof OfflineAdjudicationError)return {outcome:'unavailable',code:'configuration_unavailable'} as const;
 if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused',code:'subject_unavailable'} as const;
 if(error instanceof OfflineContextIssueError){
  if(error.reason==='configuration_unavailable')return {outcome:'unavailable',code:error.reason} as const;
  return {outcome:'refused',code:error.reason} as const;
 }
 if(error instanceof OfflineContextCloseError)return {outcome:'refused',code:error.reason} as const;
 if(error instanceof OfflineClaimError)return error.reason==='configuration_unavailable'?{outcome:'unavailable',code:error.reason} as const:{outcome:'refused',code:error.reason} as const;
 if(error instanceof OfflineClockStreamError)return error.reason==='offline_pending'?{outcome:'refused',code:'offline_pending'} as const:{outcome:'unavailable',code:'configuration_unavailable'} as const;
 if(error instanceof RequestBudgetExceeded)return {outcome:'refused',code:'rate_limited',retryAfter:error.retryAfter} as const;
 if(error instanceof z.ZodError)return {outcome:'refused',code:'invalid_request'} as const;
 throw error;
}
async function run<T>(operation:()=>Promise<T>){try{return await operation();}catch(error){return failure(error);}}
/** Call only after bearer-session authentication. Every operation proves the own subject (employment or own context)
 * before reading the deployment, then re-reads it in its commit guard. Android claim upload stays unavailable until
 * the transport task supplies the fresh payload-bound Play preparer (owner decision 2026-10-28). */
export function createDeployedOfflineClockOperations(platform:Platform,deps:{snapshot:Snapshot}){
 if((platform!=='ios'&&platform!=='android')||typeof deps?.snapshot!=='function')throw new IntegrityConfigurationUnavailable('configuration_unavailable');
 async function forEmployment(ctx:SessionContext,employmentId:unknown){
  const companyId=await ownIntegrityEnrollmentCompany(ctx,uuid.parse(employmentId));
  return companyId?readMobileOfflineDeployment(platform,ctx,companyId):null;
 }
 return {
  capabilities:(ctx:SessionContext,employmentId:string)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const d=await forEmployment(ctx,employmentId);if(!d)return notConfigured;
   return {outcome:'capabilities',protocol:1,platform,issuance:d.mode==='active'?'available':'draining',claimUpload:platform==='ios'?'available':'unavailable',close:'available'} as const;
  }),
  issue:(ctx:SessionContext,raw:unknown)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const d=await forEmployment(ctx,field(raw,'employmentId'));if(!d)return notConfigured;
   // Drain without a configured key cannot even recover an exact earlier response; with one, recovery proceeds and
   // new issuance is refused before any snapshot read or budget charge (and again by the commit guard).
   if(!d.signing)return {outcome:'unavailable',code:'draining'} as const;
   const composed=deploymentSnapshot(deps.snapshot,d);
   const snapshot:Snapshot=d.mode==='active'?composed:async()=>{throw new OfflineIssuanceDrainingError();};
   const service=createOfflineContextIssueService({apiOrigin:d.apiOrigin,issuer:d.signing.issuer,privateKey:d.signing.privateKey,maximumIssuesPerHour:d.maximumIssuesPerHour},
    {snapshot,beforeCommit:(tx,current,checked)=>assertOfflineIssueCommit(tx,current,d,checked)});
   const issued=await service.issue(ctx,raw);
   return {outcome:'issued',context:issued.raw,contextId:issued.contextId,authorization:issued.authorization} as const;
  }),
  /** Active or drain. The deployment lookup uses the company the context was issued under. */
  close:(ctx:SessionContext,raw:unknown)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const companyId=await ownOfflineContextCompany(ctx,uuid.parse(field(raw,'contextId')));if(!companyId)return {outcome:'refused',code:'context_unavailable'} as const;
   const d=await readMobileOfflineDeployment(platform,ctx,companyId);if(!d)return notConfigured;
   return await closeOwnOfflineContext(ctx,raw);
  }),
  /** Active or drain. A refusal the adjudicator decides (offline_disabled included) commits and advances the stream. */
  consume:(ctx:SessionContext,raw:unknown,attachment?:OfflineClaimPhoto)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const companyId=await ownOfflineContextCompany(ctx,uuid.parse(field(raw,'claim','context','id')));if(!companyId)return {outcome:'refused',code:'context_unavailable'} as const;
   const d=await readMobileOfflineDeployment(platform,ctx,companyId);if(!d)return notConfigured;
   if(d.platform!=='ios')return {outcome:'unavailable',code:'configuration_unavailable'} as const;
   const adjudicator=createOfflineAdjudicator({snapshot:deploymentSnapshot(deps.snapshot,d)});
   const ios=(facts:{key:{platform:string}})=>{if(facts.key.platform!=='ios')throw new IntegrityConfigurationUnavailable('configuration_unavailable');};
   // iOS: the claim's own App Attest assertion is the proof; no later transport assertion is generated.
   const service=createOfflineClaimService({apiOrigin:d.apiOrigin,photoRetentionMs:d.photoRetentionMs},{
    prepare:async(_ctx,facts)=>{ios(facts);return {assertFresh:async(_tx,current)=>ios(current)};},
    adjudicate:adjudicator.adjudicate,
    beforeCommit:(tx,current,facts)=>assertOfflineClaimCommit(tx,current,d,facts)});
   return {outcome:'receipt',receipt:await service.consume(ctx,raw,attachment)} as const;
  }),
 };
}
