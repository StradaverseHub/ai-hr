/** App assembly for durable device enrollment. Only explicit user actions advance the journal.
 * These transport paths remain unavailable until their server rollout owner mounts them. */
import {AppState,Platform} from 'react-native';
import {randomUUID} from 'expo-crypto';
import {apiGet,apiPost} from './api';
import {authGeneration,assertAuthGeneration} from './auth';
import {config,identityNamespace} from './config';
import {SessionChangedError,UnavailableError} from './errors';
import {EnrollmentScope,EnrollmentJournalUnavailable} from './enrollment-journal';
import {createIntegrityBridge} from './integrity-bridge';
import {createAndroidKeyEnrollment} from './android-key-enrollment';
import NativeIntegrity from '../modules/aihr-integrity/src/AihrIntegrityModule';
import {nativeIntegrityInstallationId,openNativeEnrollmentJournal,openNativeAndroidEnrollmentJournal} from './submission-native';
import * as C from '../../lib/mobile-integrity-contract';

/** isUnlocked must read the current session, not a captured render's boolean. The caller invalidates
 * it on unmount/selection change. The retained journal remains actor/install scoped across rehire;
 * only receipt recovery can use a different current employment, never adoption of an old command. */
export async function openOwnedDeviceEnrollment(employmentId:string,isUnlocked:()=>boolean){
 const owner=authGeneration(),namespace=identityNamespace(),apiOrigin=config.apiUrl,platform=Platform.OS;
 const check=()=>{
  assertAuthGeneration(owner);
  if(identityNamespace()!==namespace||config.apiUrl!==apiOrigin||Platform.OS!==platform)throw new SessionChangedError();
  if(!isUnlocked()||AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
 };
 async function owned<T>(fn:()=>Promise<T>){check();try{const value=await fn();check();return value;}catch(error){check();throw error;}}
 check();if(platform!=='ios'&&platform!=='android')throw new UnavailableError('Device enrollment is unavailable.');
 const me=await owned(()=>apiGet('me'));
 if(!me.actorId||!me.employments.some(value=>value.employmentId===employmentId))throw new EnrollmentJournalUnavailable();
 const appInstallationId=await owned(()=>nativeIntegrityInstallationId(check));
 const scope=EnrollmentScope.parse({namespace,apiOrigin,actorId:me.actorId,appInstallationId});
 const native=createIntegrityBridge(NativeIntegrity,check);
 const receipt=(id:string,input:{originChallengeId:string})=>apiPost(platform==='ios'?'integrity/key-receipt':'v2/integrity/key-receipt',C.IntegrityKeyLookupIntent.parse(input),{employmentId:id});
 const revoke=(id:string,input:{keyId:string})=>apiPost(platform==='ios'?'integrity/revoke':'v2/integrity/revoke',C.IntegrityRevokeIntent.parse(input),{employmentId:id});
 if(platform==='ios'){
  const journal=await owned(()=>openNativeEnrollmentJournal(scope,check,{
   native,receipt,revoke,
   prepare:(id,input)=>apiPost('integrity/enrollment/begin',C.IntegrityEnrollmentIntent.parse(input),{employmentId:id}),
   complete:(id,input)=>apiPost('integrity/enrollment/complete',C.IntegrityEnrollmentProof.parse(input),{employmentId:id}),
  }));
  return {platform:'ios' as const,status:()=>owned(()=>journal.status()),
   begin:()=>owned(()=>journal.begin(employmentId,randomUUID())),advance:()=>owned(()=>journal.advance(employmentId)),
   revoke:()=>owned(()=>journal.revoke(employmentId))};
 }
 const journal=await owned(()=>openNativeAndroidEnrollmentJournal(scope,check,{
  native:createAndroidKeyEnrollment(native,check,()=>AppState.currentState==='active'&&isUnlocked()),receipt,revoke,
  prepare:(id,input)=>apiPost('v2/integrity/android/enrollment/begin',C.IntegrityEnrollmentIntent.parse(input),{employmentId:id}),
  complete:(id,input)=>apiPost('v2/integrity/android/enrollment/complete',C.IntegrityAndroidEnrollmentProof.parse(input),{employmentId:id}),
 }));
 return {platform:'android' as const,status:()=>owned(()=>journal.status()),
  begin:()=>owned(()=>journal.begin(employmentId,randomUUID())),advance:()=>owned(()=>journal.advance(employmentId)),
  revoke:()=>owned(()=>journal.revoke(employmentId)),replace:()=>owned(()=>journal.replace(employmentId,randomUUID()))};
}
