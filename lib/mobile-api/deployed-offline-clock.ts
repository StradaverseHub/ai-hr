/** Default-closed offline-clock assembly, mounted by lib/mobile-api/offline-sync-routes.ts. Services are built per
 * request from the current deployment; nothing is cached. Without AIHR_MOBILE_OFFLINE_POLICY every operation answers
 * {outcome:'unavailable',code:'not_configured'} before any database or snapshot work. */
import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {withAttendanceTenant} from '../../core/module-gate';
import {ownIntegrityEnrollmentCompany} from '../../core/mobile-integrity-key';
import {createOfflineContextIssueService,closeOwnOfflineContext,OfflineContextIssueError,OfflineContextCloseError,type OfflineContextIssuePorts} from '../../core/mobile-offline-context';
import {createOfflineClaimService,OfflineClaimError,type OfflineClaimPhoto,type OfflineClaimPorts} from '../../core/mobile-offline-claim';
import {OfflineClockStreamError} from '../../core/mobile-offline-lease';
import {readMobileOfflineDeployment,assertOfflineIssueCommit,assertOfflineClaimCommit,ownOfflineContextCompany,isMobileOfflineDeploymentPresent,OfflineIssuanceDrainingError,type MobileOfflineDeployment} from '../../core/mobile-offline-rollout';
import {createOfflineAdjudicator,offlineClockSnapshotPort,readOfflineClockingPolicyTx,OfflineAdjudicationError,OwnClockEmploymentUnavailableError} from '../../packs/attendance/service';
import {RequestBudgetExceeded} from '../request-budget';
import {IntegrityConfigurationUnavailable} from './integrity-configuration';
import {readDeployedPlayCredentials} from './play-credentials';
import type {PlayAccessTokenProvider} from './play-integrity';
import {createOfflineSyncIntegrityVerifier,OfflineSyncIntegrityError} from './offline-sync-integrity';
import {OfflineClockProofUnavailable} from './offline-clock-proof';
type Platform='ios'|'android';
type Snapshot=OfflineContextIssuePorts['snapshot'];
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const notConfigured={outcome:'unavailable',code:'not_configured'} as const;
const configurationUnavailable={outcome:'unavailable',code:'configuration_unavailable'} as const;
const field=(value:unknown,...path:string[])=>path.reduce<unknown>((at,key)=>at&&typeof at==='object'?Reflect.get(at,key):undefined,value);
/** The ONE snapshot port, built per request from the resolved deployment: window, permit count and app target have a
 * single owner (this deployment and its clock rollout entry), and issuance and the adjudicator take the same function,
 * so an unchanged world records and compares identical values. Policy, sites and attendance are the snapshot owner's. */
const deploymentSnapshot=(d:MobileOfflineDeployment):Snapshot=>offlineClockSnapshotPort({target:d.target,windowMs:d.windowMs,permitCount:d.permitCount});
/** Server-owned Google credentials and transport, never selected by request fields (the online signed-clock shape). */
export type OfflineAndroidPlayAssembly={accessToken:PlayAccessTokenProvider|null;transport?:typeof fetch;timeoutMs?:number;assertCurrent?:()=>void};
export type DeployedOfflineClockOptions={androidPlay?:OfflineAndroidPlayAssembly|(()=>OfflineAndroidPlayAssembly)};
/** Transport facts for one claim upload. Android only: the fresh sync-time Play token and the uploading build. */
export type OfflineClaimTransport={employmentId?:string;playIntegrityToken?:string;syncBuildVersion?:string;signal?:AbortSignal};
function failure(error:unknown){
 // Budget exhaustion propagates to mobileRoute, which answers HTTP 429 with retry-after (no body detail).
 if(error instanceof RequestBudgetExceeded)throw error;
 if(error instanceof IntegrityConfigurationUnavailable)return {outcome:'unavailable',code:error.reason} as const;
 if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable',code:'module_unavailable'} as const;
 if(error instanceof OfflineIssuanceDrainingError)return {outcome:'unavailable',code:'draining'} as const;
 if(error instanceof OfflineAdjudicationError)return configurationUnavailable;
 if(error instanceof OfflineClockProofUnavailable)return configurationUnavailable;
 if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused',code:'subject_unavailable'} as const;
 if(error instanceof OfflineSyncIntegrityError){
  const r=error.result;
  if(r.status==='refused')return {outcome:'refused',code:'sync_integrity',integrityReason:r.reason} as const;
  return {outcome:'unavailable',code:r.reason==='configuration_unavailable'?'configuration_unavailable':'proof_unavailable',integrityReason:r.reason} as const;
 }
 if(error instanceof OfflineContextIssueError){
  if(error.reason==='configuration_unavailable')return {outcome:'unavailable',code:error.reason} as const;
  return {outcome:'refused',code:error.reason} as const;
 }
 if(error instanceof OfflineContextCloseError)return {outcome:'refused',code:error.reason} as const;
 if(error instanceof OfflineClaimError)return error.reason==='configuration_unavailable'?{outcome:'unavailable',code:error.reason} as const:{outcome:'refused',code:error.reason} as const;
 if(error instanceof OfflineClockStreamError)return error.reason==='offline_pending'?{outcome:'refused',code:'offline_pending'} as const:configurationUnavailable;
 if(error instanceof z.ZodError)return {outcome:'refused',code:'invalid_request'} as const;
 throw error;
}
async function run<T>(operation:()=>Promise<T>){try{return await operation();}catch(error){return failure(error);}}
/** Call only after bearer-session authentication. Every operation proves the own subject (employment or own context)
 * before reading the deployment, then re-reads it in its commit guard. */
export function createDeployedOfflineClockOperations(platform:Platform,options:DeployedOfflineClockOptions={}){
 if(platform!=='ios'&&platform!=='android')throw new IntegrityConfigurationUnavailable('configuration_unavailable');
 const play=():OfflineAndroidPlayAssembly=>{const value=options.androidPlay??readDeployedPlayCredentials;return typeof value==='function'?value():value;};
 async function forEmployment(ctx:SessionContext,employmentId:unknown){
  const companyId=await ownIntegrityEnrollmentCompany(ctx,uuid.parse(employmentId));
  const d=companyId?await readMobileOfflineDeployment(platform,ctx,companyId):null;
  return d&&companyId?{d,companyId}:null;
 }
 // An Android deployment without a usable Google credential can never accept an upload: it neither advertises nor
 // issues (a context would hold the key lease, blocking online clocking, for claims that could not sync).
 const playReady=()=>platform==='ios'||Boolean(play()?.accessToken);
 return {
  /** company offline off -> refused offline_disabled; enabled:false while draining (close and upload stay available). */
  capabilities:(ctx:SessionContext,employmentId:string)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const found=await forEmployment(ctx,employmentId);if(!found)return notConfigured;
   const {d,companyId}=found;if(!playReady())return configurationUnavailable;
   const company=await withAttendanceTenant(ctx,tx=>readOfflineClockingPolicyTx(tx,companyId));
   if(!company.enabled)return {outcome:'refused',code:'offline_disabled'} as const;
   return {outcome:'offline',enabled:d.mode==='active',apiOrigin:d.apiOrigin,companyId,windowMs:d.windowMs,permitCount:d.permitCount} as const;
  }),
  /** Issue, or the exact recovery of an earlier request (the refresh). Keyless (D16): recovery needs no key in either mode,
   * so a drained deployment still returns the recorded bytes and the phone can learn its context id and close it. */
  issue:(ctx:SessionContext,raw:unknown)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const found=await forEmployment(ctx,field(raw,'employmentId'));if(!found)return notConfigured;
   const {d}=found;if(!playReady())return configurationUnavailable;
   // Drain: recovery proceeds; new issuance is refused before any snapshot read or budget charge (and again by the commit guard).
   const snapshot:Snapshot=d.mode==='active'?deploymentSnapshot(d):async()=>{throw new OfflineIssuanceDrainingError();};
   const service=createOfflineContextIssueService({apiOrigin:d.apiOrigin,maximumIssuesPerHour:d.maximumIssuesPerHour},
    {snapshot,beforeCommit:(tx,current,checked)=>assertOfflineIssueCommit(tx,current,d,checked)});
   const issued=await service.issue(ctx,raw);
   return {outcome:'issued',context:issued.raw,contextId:issued.contextId,authorization:issued.authorization} as const;
  }),
  /** Active or drain. The deployment lookup uses the company the context was issued under. */
  close:(ctx:SessionContext,raw:unknown,employmentId?:string)=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const companyId=await ownOfflineContextCompany(ctx,uuid.parse(field(raw,'contextId')),employmentId);if(!companyId)return {outcome:'refused',code:'context_unavailable'} as const;
   const d=await readMobileOfflineDeployment(platform,ctx,companyId);if(!d)return notConfigured;
   return await closeOwnOfflineContext(ctx,raw);
  }),
  /** Active or drain. A refusal the adjudicator decides (offline_disabled included) commits and advances the stream.
   * Ordering (both platforms): the client sends claim N+1 only after claim N has a terminal receipt; the service
   * verifies each claim's ORIGINAL proof against the stream cursor, so an early N+1 is chain_conflict, nothing consumed.
   * iOS: the claim's own App Attest assertion is the proof and its counter is verified and advanced inside consumption;
   * no transport assertion is ever generated or accepted here (a fresh higher counter would strand queued claims).
   * Android: the fresh payload-bound Play check runs in prepare, after exact receipt recovery and outside locks. */
  consume:(ctx:SessionContext,raw:unknown,attachment?:OfflineClaimPhoto,transport:OfflineClaimTransport={})=>run(async()=>{
   if(!isMobileOfflineDeploymentPresent())return notConfigured;
   const companyId=await ownOfflineContextCompany(ctx,uuid.parse(field(raw,'claim','context','id')),transport.employmentId);if(!companyId)return {outcome:'refused',code:'context_unavailable'} as const;
   const d=await readMobileOfflineDeployment(platform,ctx,companyId);if(!d)return notConfigured;
   const adjudicator=createOfflineAdjudicator({snapshot:deploymentSnapshot(d)});
   const same=(facts:{key:{platform:string}})=>{if(facts.key.platform!==platform||d.platform!==platform)throw new IntegrityConfigurationUnavailable('configuration_unavailable');};
   const prepare:OfflineClaimPorts['prepare']=platform==='ios'
    ?async(_ctx,facts)=>{same(facts);return {assertFresh:async(_tx,current)=>same(current)};}
    :async(_ctx,facts)=>{
     same(facts);const clock=d.clock.configuration,google=play();
     if(!('settings' in clock)||!google?.accessToken)throw new IntegrityConfigurationUnavailable('configuration_unavailable');
     // Already verified by consumption against the stored context and key; hashed here exactly as the receipt stores it.
     const signature=field(raw,'proof','signature');if(typeof signature!=='string')throw new OfflineClaimError('invalid_proof');
     const verify=createOfflineSyncIntegrityVerifier(clock.settings,clock.policy,google.accessToken,{transport:google.transport,timeoutMs:google.timeoutMs});
     const result=await verify(transport.playIntegrityToken,{claimDigest:facts.digest,signatureSha256:createHash('sha256').update(Buffer.from(signature,'base64')).digest('hex'),
      syncBuildVersion:transport.syncBuildVersion??''},transport.signal);
     if(result.status!=='eligible')throw new OfflineSyncIntegrityError(result);
     google.assertCurrent?.();
     return {assertFresh:async(_tx,current)=>{same(current);google.assertCurrent?.();}};
    };
   const service=createOfflineClaimService({apiOrigin:d.apiOrigin,photoRetentionMs:d.photoRetentionMs},{
    prepare,adjudicate:adjudicator.adjudicate,beforeCommit:(tx,current,facts)=>assertOfflineClaimCommit(tx,current,d,facts)});
   return {outcome:'processed',receipt:await service.consume(ctx,raw,attachment)} as const;
  }),
 };
}
