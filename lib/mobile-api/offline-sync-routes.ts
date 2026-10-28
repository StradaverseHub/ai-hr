/** Offline clock sync HTTP boundary (wire contracts and limits: lib/mobile-offline-contract.ts). Every route authenticates
 * through mobileRoute (bearer session) and proves the ?employmentId= selector with integrityEmployment before any body is
 * read or any deployment is consulted, as the online signed-clock routes do. Bodies are bounded on the stream before
 * parsing; framing and size violations are 400 bad_request, as online. A claim that is framed correctly but malformed is a
 * typed refusal (invalid_claim), never a 500, and is never handed to consumption (whose parse throws).
 * Inert by default: no AIHR_MOBILE_OFFLINE_POLICY -> {outcome:'unavailable',code:'not_configured'} (HTTP 200). */
import type {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {ModuleNotEnabledError} from '../../core/entitlements';
import {OwnClockEmploymentUnavailableError} from '../../packs/attendance/service';
import * as C from '../mobile-offline-contract';
import {mobileRoute,MobileBadRequest,type MobileBudget,type MobileSessionResolver} from './handler';
import {integrityEmployment} from './integrity-request';
import {mobileForm,mobileInput} from './body';
import {createDeployedOfflineClockOperations,type DeployedOfflineClockOptions} from './deployed-offline-clock';
type Platform='ios'|'android';
const invalidClaim={outcome:'refused',code:'invalid_claim'} as const;
async function guarded<T>(fn:()=>Promise<T>){
 try{return await fn();}
 catch(error){
  if(error instanceof OwnClockEmploymentUnavailableError)return {outcome:'refused',code:'subject_unavailable'} as const;
  if(error instanceof ModuleNotEnabledError)return {outcome:'unavailable',code:'module_unavailable'} as const;
  throw error;
 }
}
async function json<S extends z.ZodType>(req:Request,schema:S,limit:number):Promise<z.output<S>>{
 const parsed=schema.safeParse(await mobileInput(req,limit));if(!parsed.success)throw new MobileBadRequest('Invalid offline request');return parsed.data;
}
/** Multipart claim upload. iOS fields: claim, photo?. Android adds playIntegrityToken? and syncBuildVersion? (both or
 * neither; an exact receipt retry needs neither, a new claim needs both). */
async function claimForm(req:Request,platform:Platform){
 const L=C.OFFLINE_SYNC_LIMITS;
 const fields=await mobileForm(req,platform==='android'?['claim','photo','playIntegrityToken','syncBuildVersion']:['claim','photo'],L.claimFormBytes);
 const raw=fields.get('claim'),file=fields.get('photo'),token=fields.get('playIntegrityToken'),build=fields.get('syncBuildVersion');
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>L.claimBytes)throw new MobileBadRequest('Invalid claim field');
 if(file!==null&&(!(file instanceof File)||file.size<1||file.size>L.photoBytes||!['image/jpeg','image/png'].includes(file.type)))throw new MobileBadRequest('Invalid photo');
 if((token===null)!==(build===null))throw new MobileBadRequest('Integrity fields go together');
 const playIntegrityToken=token===null?undefined:C.OfflineSyncPlayToken.safeParse(token),syncBuildVersion=build===null?undefined:C.OfflineSyncBuildVersion.safeParse(build);
 if(playIntegrityToken&&!playIntegrityToken.success||syncBuildVersion&&!syncBuildVersion.success)throw new MobileBadRequest('Invalid integrity field');
 let input:unknown;try{input=JSON.parse(raw);}catch{return null;}
 const signed=C.OfflineClaimUpload.safeParse(input);if(!signed.success||signed.data.proof.platform!==platform)return null;
 return {signed:signed.data,
  photo:file instanceof File?{bytes:Buffer.from(await file.arrayBuffer()),mimeType:file.type as 'image/jpeg'|'image/png'}:undefined,
  playIntegrityToken:playIntegrityToken?.success?playIntegrityToken.data:undefined,syncBuildVersion:syncBuildVersion?.success?syncBuildVersion.data:undefined};
}
/** Route operations over the deployed assembly. `options` injects server-owned Google transport for tests only. */
export function createOfflineSyncOperations(platform:Platform,options:DeployedOfflineClockOptions={}){
 const deployed=createDeployedOfflineClockOperations(platform,options);
 return {
  capabilities:async(ctx:SessionContext,req:Request)=>C.OfflineCapabilitiesResult.parse(await guarded(async()=>{
   const id=await integrityEmployment(ctx,req);return deployed.capabilities(ctx,id);
  })),
  /** Issue or refresh: re-posting the same request returns the exact original recorded context (unsigned, D16). */
  context:async(ctx:SessionContext,req:Request)=>C.OfflineContextResult.parse(await guarded(async()=>{
   const id=await integrityEmployment(ctx,req),request=await json(req,C.OfflineContextIssueRequest,C.OFFLINE_SYNC_LIMITS.contextBytes);
   return deployed.issue(ctx,{employmentId:id,request});
  })),
  close:async(ctx:SessionContext,req:Request)=>C.OfflineCloseResult.parse(await guarded(async()=>{
   const id=await integrityEmployment(ctx,req),request=await json(req,C.OfflineContextCloseRequest,C.OFFLINE_SYNC_LIMITS.closeBytes);
   return deployed.close(ctx,request,id);
  })),
  /** One claim per request, in chain order: N+1 only after N has a terminal receipt. No transport assertion on iOS. */
  claim:async(ctx:SessionContext,req:Request)=>C.OfflineClaimResult.parse(await guarded(async()=>{
   const id=await integrityEmployment(ctx,req),upload=await claimForm(req,platform);if(!upload)return invalidClaim;
   if(upload.signed.claim.scope.employmentId!==id)return {outcome:'refused',code:'binding_conflict'} as const;
   return deployed.consume(ctx,upload.signed,upload.photo,{employmentId:id,playIntegrityToken:upload.playIntegrityToken,syncBuildVersion:upload.syncBuildVersion,signal:req.signal});
  })),
 };
}
/** Handler-level assembly for tests: the same operations behind mobileRoute with an injected session resolver/budget. */
export function createOfflineSyncHttpHandlers(platform:Platform,resolve?:MobileSessionResolver,options:DeployedOfflineClockOptions&{budget?:MobileBudget}={}){
 const operations=createOfflineSyncOperations(platform,options);
 return {capabilities:mobileRoute(C.OfflineCapabilitiesResult,operations.capabilities,resolve,options.budget),
  context:mobileRoute(C.OfflineContextResult,operations.context,resolve,options.budget),
  close:mobileRoute(C.OfflineCloseResult,operations.close,resolve,options.budget),
  claim:mobileRoute(C.OfflineClaimResult,operations.claim,resolve,options.budget)};
}
