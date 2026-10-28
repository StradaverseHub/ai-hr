/** Owned native assembly. Opening/status never signs or uploads an attendance command. With the offline build switch
 * off (the default) this is exactly the online assembly: no offline ports, no anchor read, no extra request. */
import {AppState,Platform} from 'react-native';
import {File} from 'expo-file-system';
import {ClockCommand} from '../../lib/mobile-api/contract';
import {ClockSourceSignals,OnlineClockIntegrityData} from '../../lib/mobile-clock-integrity';
import * as C from '../../lib/mobile-integrity-contract';
import {apiGet,apiPost} from './api';
import {authGeneration,assertAuthGeneration} from './auth';
import {config,identityNamespace,offlineClockingBuild} from './config';
import {SessionChangedError,UnavailableError} from './errors';
import {EnrollmentScope} from './enrollment-journal';
import {ClockSigningKey} from './clock-signing-key';
import {openOwnedDeviceEnrollment} from './device-enrollment';
import {openOwnedClockJournal} from './submission-recovery';
import {nativeIntegrityInstallationId,openNativeSignedClockJournal} from './submission-native';
import {createIntegrityBridge} from './integrity-bridge';
import {createAndroidClockSigner} from './android-clock-signing';
import {onlineClockClientDataHash} from './clock-integrity';
import NativeIntegrity from '../modules/aihr-integrity/src/AihrIntegrityModule';
import {appendAttachment} from './capture';
import {SignedClockConflict,SignedClockUnavailable,type SignedClockReference} from './signed-clock-journal';
import type {EvidenceFile,JournalEntry} from './submission-journal';
import {createOfflineClockPorts,readOfflineCapabilities,offlineClockIdentity} from './offline-clock-ports';
import type {z} from 'zod';
import type {OfflineClockContextTarget} from '../../lib/mobile-offline-context';

export async function openOwnedSignedClock(employmentId:string,isUnlocked:()=>boolean){
 const owner=authGeneration(),namespace=identityNamespace(),apiOrigin=config.apiUrl,platform=Platform.OS;
 const check=()=>{
  assertAuthGeneration(owner);
  if(identityNamespace()!==namespace||config.apiUrl!==apiOrigin||Platform.OS!==platform)throw new SessionChangedError();
  if(!isUnlocked()||AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
 };
 async function owned<T>(run:()=>Promise<T>){check();try{const value=await run();check();return value;}catch(error){check();throw error;}}
 check();if(platform!=='ios'&&platform!=='android')throw new SignedClockUnavailable('unsupported');
 const nativePlatform:'ios'|'android'=platform;
 // Offline cold start (switch on, no HTTP response for `me`): this session's own device-only anchor, never another's.
 const identity=await owned(()=>apiGet('me')).then(me=>({me,anchor:null}),async(error:unknown)=>{
  const anchor=await offlineClockIdentity(error,{namespace,apiOrigin,employmentId},check);if(!anchor)throw error;check();return {me:null,anchor};
 });
 const me=identity.me;
 if(me&&(!me.actorId||!me.employments.some(value=>value.employmentId===employmentId)))throw new SignedClockConflict();
 const actorId=me?me.actorId!:identity.anchor!.actorId,appInstallationId=await owned(()=>nativeIntegrityInstallationId(check));
 const scope=EnrollmentScope.parse({namespace,apiOrigin,actorId,appInstallationId});
 const native=createIntegrityBridge(NativeIntegrity,check),signAndroid=createAndroidClockSigner(native,check,isUnlocked);
 const operation={assertCurrent:check};
 const capabilities=()=>owned(()=>apiGet(platform==='ios'?'v2/integrity/ios/clock/capabilities':'v2/integrity/android/clock/capabilities',{employmentId}));
 const key=async()=>{
  const initial=native.capabilities();check();
  if(initial.status!=='evidence')throw new SignedClockUnavailable(initial.status==='unsupported'?'unsupported':'native_unavailable');
  if(initial.evidence.platform!==platform||initial.evidence.keyMechanism==='unsupported')throw new SignedClockUnavailable('unsupported');
  const controller=await owned(()=>openOwnedDeviceEnrollment(employmentId,isUnlocked));
  if(!controller.supported)throw new SignedClockUnavailable('unsupported');
  if(!controller.signingKey)throw new SignedClockUnavailable('registration_required');
  const key=ClockSigningKey.parse(await owned(()=>controller.signingKey!())),capability=native.capabilities();check();
  if(key.platform!==platform||key.actorId!==actorId||key.apiOrigin!==apiOrigin||key.appInstallationId!==appInstallationId)throw new SignedClockConflict();
  if(capability.status!=='evidence')throw new SignedClockUnavailable(capability.status==='unsupported'?'unsupported':'native_unavailable');
  if(capability.evidence.platform!==platform||capability.evidence.keyMechanism==='unsupported')throw new SignedClockUnavailable('unsupported');
  return {key,capability:capability.evidence};
 };
 async function withBase<T>(selected:string,id:string,run:(entry:JournalEntry,command:ReturnType<typeof ClockCommand.parse>,file?:EvidenceFile)=>Promise<T>){
  if(selected!==employmentId)throw new SignedClockConflict();
  const journal=await owned(()=>openOwnedClockJournal(selected,actorId));
  const entry=(await owned(()=>journal.pending())).find(value=>value.kind==='clock'&&value.requestId===id);
  if(!entry||entry.stage||!entry.integrity)throw new SignedClockUnavailable('saved_command');
  const restored=await journal.restore(entry);
  try{
   check();const command=ClockCommand.parse(JSON.parse(restored.command));if(command.requestId!==id)throw new SignedClockConflict();
   return await run(entry,command,restored.file);
  }finally{if(restored.file)try{const file=new File(restored.file.uri);if(file.exists)file.delete();}catch{/* Launch purges this cache too. */}}
 }
 const base=(selected:string,id:string)=>withBase(selected,id,async entry=>({
  digest:entry.digest,command:ClockCommand.parse(JSON.parse(entry.command)),source:ClockSourceSignals.parse(entry.integrity!.source),
  photo:entry.evidence?OnlineClockIntegrityData.shape.command.shape.photo.parse({sha256:entry.evidence.digest,byteLength:entry.evidence.size,mimeType:entry.evidence.mimeType}):null,
 }));
 const resolveBase=async(reference:SignedClockReference)=>{
  if(reference.employmentId!==employmentId)throw new SignedClockConflict();
  const journal=await owned(()=>openOwnedClockJournal(employmentId,actorId)),entries=await owned(()=>journal.pending());
  const entry=entries.find(value=>value.kind==='clock'&&value.requestId===reference.requestId);
  if(!entry)return;
  if(entry.digest!==reference.baseDigest||!entry.integrity)throw new SignedClockConflict();
  await owned(()=>journal.resolve('clock',reference.requestId));
 };
 // Late-bound: the offline ports reach the store's guarded photo custody, which the opened journal owns.
 let store:Awaited<ReturnType<typeof openNativeSignedClockJournal>>|null=null;
 const custody=()=>{if(!store)throw new SignedClockUnavailable('storage');return store;};
 const offline=offlineClockingBuild?createOfflineClockPorts({platform:nativePlatform,employmentId,namespace,apiOrigin,check,operation,native,
  isForeground:()=>AppState.currentState==='active'&&isUnlocked(),
  photos:{read:(id,photo)=>custody().readOfflinePhoto(id,photo),retain:(id,photo,bytes)=>custody().retainOfflinePhoto(id,photo,bytes),remove:id=>custody().deleteOfflinePhoto(id)},
  basePhoto:id=>withBase(employmentId,id,async(_entry,_command,file)=>{if(!file)throw new SignedClockUnavailable('saved_command');return new File(file.uri).bytes();}),
  resolveBase,
  cloudProject:async()=>{const value=C.IntegrityClockCapabilities.parse(await capabilities());return value.outcome==='capabilities'&&value.platform===platform?value.cloudProjectNumber:null;},
 }):undefined;
 const journal=await owned(()=>openNativeSignedClockJournal(scope,check,{
  base,key,capabilities,resolveBase,...(offline?{offline}:{}),
  receipt:(selected,id)=>owned(()=>apiGet('submission-receipt',{employmentId:selected,kind:'clock',requestId:id})),
  abandon:(selected,id)=>owned(()=>apiPost('submission-abandon',{kind:'clock',requestId:id},{employmentId:selected},operation)),
  begin:(pending,input)=>withBase(pending.employmentId,pending.requestId,async(entry,_command,file)=>{
   if(entry.digest!==pending.baseDigest)throw new SignedClockConflict();
   const command=(platform==='ios'?C.IntegrityClockIntent:C.IntegrityAndroidClockIntent).parse(input);
   const form=new FormData();form.append('command',JSON.stringify(command));if(file)appendAttachment(form,'photo',file);check();
   return owned(()=>apiPost(platform==='ios'?'v2/integrity/ios/clock/begin':'v2/integrity/android/clock/begin',form,{employmentId},operation));
  }),
  complete:(pending,input,token)=>withBase(pending.employmentId,pending.requestId,async(entry,_command,file)=>{
   if(entry.digest!==pending.baseDigest)throw new SignedClockConflict();
   const command=(platform==='ios'?C.IntegrityClockProof:C.IntegrityAndroidClockProof).parse(input);
   const form=new FormData();form.append('command',JSON.stringify(command));if(file)appendAttachment(form,'photo',file);
   if(platform==='android')form.append('playIntegrityToken',C.IntegrityAndroidClockToken.parse(token));check();
   return owned(()=>apiPost(platform==='ios'?'v2/integrity/ios/clock/complete':'v2/integrity/android/clock/complete',form,{employmentId},operation));
  }),
  async sign(signingKey,context){
   if(signingKey.platform!==platform)throw new SignedClockConflict();
   if(platform==='android')return signAndroid(signingKey.nativeReference,context);
   const capability=native.capabilities();check();
   if(capability.status!=='evidence')return capability;
   const c=capability.evidence,e=context.evidence;
   if(c.platform!=='ios'||c.keyMechanism!=='apple_app_attest'||c.appId!==e.appId||c.appVersion!==e.appVersion||c.buildVersion!==e.buildVersion)throw new SignedClockConflict();
   const hash=await owned(()=>onlineClockClientDataHash(context,check));
   return owned(()=>native.assertAppleKey(signingKey.nativeReference,hash));
  },
  async play(project,context){
   if(platform!=='android')throw new SignedClockConflict();
   const prepared=await owned(()=>native.preparePlayIntegrity(project));if(prepared.status!=='evidence')return prepared;
   const hash=await owned(()=>onlineClockClientDataHash(context,check));
   return owned(()=>native.requestPlayIntegrity(hash.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')));
  },
 }));
 store=journal;
 /** The offline context target: the enrolled key's app, and on iPhone the stored receipt's App Attest environment. */
 async function offlineTarget():Promise<z.infer<typeof OfflineClockContextTarget>>{
  const current=(await key()).key;
  if(current.platform==='android')return {platform:'android',appId:current.appId,environment:null};
  const controller=await owned(()=>openOwnedDeviceEnrollment(employmentId,isUnlocked));
  if(!controller.signingEnvironment)throw new SignedClockUnavailable('unsupported');
  return {platform:'ios',appId:current.appId,environment:await owned(()=>controller.signingEnvironment!())};
 }
 return {
  platform,capabilities,key,
  /** Identity this controller opened with: `anchored` means an offline cold start from the device-only anchor. */
  identity:{namespace,apiOrigin,actorId,appInstallationId,employmentId,anchored:!me},
  offline:offline?{
   capabilities:()=>owned(()=>readOfflineCapabilities({platform:nativePlatform,employmentId,namespace,apiOrigin,check})),
   target:offlineTarget,
   snapshot:()=>{const value=native.clockSnapshot();check();return value;},
   reserve:(binding:unknown)=>owned(()=>journal.reserveOffline(binding)),
   prepare:(requestId:string)=>owned(()=>journal.prepareOffline(requestId)),
   abandon:(requestId:string,code:string)=>owned(()=>journal.abandonReservation(requestId,code)),
   release:()=>owned(()=>journal.releaseUnusedContext()),
   capture:(input:unknown)=>owned(()=>journal.captureOffline(input)),
   sign:(requestId:string,contextId:string)=>owned(()=>journal.signOffline(requestId,contextId)),
   uploadNext:()=>owned(()=>journal.uploadNextOffline()),
   close:(closeRequestId:string)=>owned(()=>journal.closeOffline(closeRequestId)),
   handback:(closeRequestId:string)=>owned(()=>journal.handbackUnusedContext(closeRequestId)),
   removeUndeliverable:(requestId:string)=>owned(()=>journal.removeUndeliverable(requestId)),
   claims:()=>owned(()=>journal.offlineClaims(employmentId)),
  }:null,
  status:()=>owned(()=>journal.status(employmentId)),
  start:(requestId:string)=>owned(()=>journal.start(employmentId,requestId)),
  advance:(requestId?:string)=>owned(()=>journal.advance(employmentId,requestId)),
  recover:(abandon=false,requestId?:string)=>owned(()=>journal.recover(employmentId,abandon,requestId)),
 };
}
