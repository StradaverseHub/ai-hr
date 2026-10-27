/** Owned native assembly. Opening/status never signs or uploads an attendance command. */
import {AppState,Platform} from 'react-native';
import {File} from 'expo-file-system';
import {ClockCommand} from '../../lib/mobile-api/contract';
import {ClockSourceSignals,OnlineClockIntegrityData} from '../../lib/mobile-clock-integrity';
import * as C from '../../lib/mobile-integrity-contract';
import {apiGet,apiPost} from './api';
import {authGeneration,assertAuthGeneration} from './auth';
import {config,identityNamespace} from './config';
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

export async function openOwnedSignedClock(employmentId:string,isUnlocked:()=>boolean){
 const owner=authGeneration(),namespace=identityNamespace(),apiOrigin=config.apiUrl,platform=Platform.OS;
 const check=()=>{
  assertAuthGeneration(owner);
  if(identityNamespace()!==namespace||config.apiUrl!==apiOrigin||Platform.OS!==platform)throw new SessionChangedError();
  if(!isUnlocked()||AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
 };
 async function owned<T>(run:()=>Promise<T>){check();try{const value=await run();check();return value;}catch(error){check();throw error;}}
 check();if(platform!=='ios'&&platform!=='android')throw new SignedClockUnavailable('unsupported');
 const me=await owned(()=>apiGet('me'));
 if(!me.actorId||!me.employments.some(value=>value.employmentId===employmentId))throw new SignedClockConflict();
 const actorId=me.actorId,appInstallationId=await owned(()=>nativeIntegrityInstallationId(check));
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
 const journal=await owned(()=>openNativeSignedClockJournal(scope,check,{
  base,key,capabilities,resolveBase,
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
 return {
  platform,capabilities,key,
  status:()=>owned(()=>journal.status(employmentId)),
  start:(requestId:string)=>owned(()=>journal.start(employmentId,requestId)),
  advance:(requestId?:string)=>owned(()=>journal.advance(employmentId,requestId)),
  recover:(abandon=false,requestId?:string)=>owned(()=>journal.recover(employmentId,abandon,requestId)),
 };
}
