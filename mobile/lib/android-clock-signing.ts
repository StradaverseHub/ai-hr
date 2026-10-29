/** Local signing only. The caller must persist command/signature before upload; no replay or send. */
import {OnlineClockIntegrityData,onlineClockClientData} from '../../lib/mobile-clock-integrity';
import type {createIntegrityBridge,NativeIntegrityResult} from './integrity-bridge';
import {UnavailableError} from './errors';
/** Scope owner covers actor/connection/employment/generation. Foreground is checked separately so
 * an asynchronous native reply cannot publish an action after privacy lock or screen exit. */
export function createAndroidClockSigner(native:ReturnType<typeof createIntegrityBridge>,assertCurrent:()=>void,isForeground:()=>boolean){
 const owned=()=>{assertCurrent();if(!isForeground())throw new UnavailableError('Unlock the app to continue.');};
 return async(alias:string,input:unknown):Promise<NativeIntegrityResult<string>>=>{
  owned();const parsed=OnlineClockIntegrityData.safeParse(input);
  if(!parsed.success||parsed.data.evidence.platform!=='android')return {status:'invalid',reason:'invalid_input'};
  const capabilities=native.capabilities();owned();
  if(capabilities.status!=='evidence')return capabilities;
  const capability=capabilities.evidence,evidence=parsed.data.evidence;
  if(capability.platform!=='android'||capability.keyMechanism!=='android_keystore')return {status:'unsupported',reason:'unsupported'};
  if(capability.appId!==evidence.appId||capability.appVersion!==evidence.appVersion||capability.buildVersion!==evidence.buildVersion)return {status:'invalid',reason:'invalid_input'};
  const bytes=new TextEncoder().encode(onlineClockClientData(parsed.data));
  if(bytes.length<1||bytes.length>16384)return {status:'invalid',reason:'invalid_input'};
  const encoded=btoa(Array.from(bytes,value=>String.fromCharCode(value)).join(''));
  owned();
  try{const result=await native.signAndroidCommand(alias,encoded);owned();return result;}
  catch(error){owned();throw error;}
 };
}
