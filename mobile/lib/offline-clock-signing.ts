/** Local signing/recovery only. These operations neither authorize a subject nor submit attendance. */
import {CryptoDigestAlgorithm,CryptoEncoding,digestStringAsync} from 'expo-crypto';
import {OfflineClockAndroidSignature,OfflineClockClaimData,offlineClockClaimClientData} from '../../lib/mobile-offline-clock';
import type {OfflineClockProofPorts} from './offline-clock-state';
import {ClockSigningKey} from './clock-signing-key';
import type {createIntegrityBridge,NativeIntegrityResult} from './integrity-bridge';
import {UnavailableError} from './errors';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes:Uint8Array){
 let result='';for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2],value=(a<<16)|((b??0)<<8)|(c??0);
  result+=alphabet[(value>>>18)&63]+alphabet[(value>>>12)&63]+(b===undefined?'=':alphabet[(value>>>6)&63])+(c===undefined?'=':alphabet[value&63]);}
 return result;
}
export function createOfflineClockSigner(native:ReturnType<typeof createIntegrityBridge>,assertCurrent:()=>void,isForeground:()=>boolean):Omit<OfflineClockProofPorts,'verifyPhoto'>{
 const owned=()=>{assertCurrent();if(!isForeground())throw new UnavailableError('Unlock the app to continue.');};
 function data(rawKey:unknown,input:unknown){
  owned();const key=ClockSigningKey.safeParse(rawKey),claim=OfflineClockClaimData.safeParse(input);if(!key.success||!claim.success)return null;
  const k=key.data,p=claim.data,s=p.scope;
  if(k.platform!==p.evidence.platform||k.apiOrigin!==s.apiOrigin||k.installationId!==s.installationId||k.tenantId!==s.tenantId||k.actorId!==s.actorId||k.appInstallationId!==s.appInstallationId||k.keyId!==s.deviceKeyId||
   p.evidence.appId!==(k.platform==='ios'?k.appId.slice(11):k.appId))return null;
  const canonical=offlineClockClaimClientData(p),bytes=new TextEncoder().encode(canonical);if(bytes.byteLength<1||bytes.byteLength>16384)return null;
  return {key:k,claim:p,canonical,bytes};
 }
 function capabilities(p:NonNullable<ReturnType<typeof data>>,signing=false){
  const result=native.capabilities();owned();if(result.status!=='evidence')return result;
  const c=result.evidence,k=p.key;
  if(c.platform!==k.platform||c.appId!==(k.platform==='ios'?k.appId.slice(11):k.appId))return {status:'invalid',reason:'invalid_input'} as const;
  if(signing&&c.keyMechanism!==(k.platform==='ios'?'apple_app_attest':'android_keystore'))return {status:'unsupported',reason:'unsupported'} as const;
  // Versions are capture-time reports. A later legitimate app upgrade must not rewrite that claim.
  return result;
 }
 async function hash(p:NonNullable<ReturnType<typeof data>>){
  owned();try{const result=await digestStringAsync(CryptoDigestAlgorithm.SHA256,p.canonical,{encoding:CryptoEncoding.BASE64});owned();return result;}catch(error){owned();throw error;}
 }
 const invalid={status:'invalid',reason:'invalid_input'} as const;
 return {
  async inspect(rawKey:unknown,input:unknown){
   const p=data(rawKey,input);if(!p)return invalid;const c=capabilities(p);if(c.status!=='evidence')return c;
   if(p.key.platform==='android')return {status:'evidence',evidence:{state:'absent' as const},verification:'not_verified'} as const;
   if(!native.appleOfflineProofRecoverySupported())return {status:'unsupported',reason:'method_missing'} as const;
   const digest=await hash(p);owned();try{const result=await native.appleOfflineProofInfo(p.key.nativeReference,digest);owned();return result;}catch(error){owned();throw error;}
  },
  async sign(rawKey:unknown,input:unknown):Promise<NativeIntegrityResult<string>>{
   const p=data(rawKey,input);if(!p)return invalid;const c=capabilities(p,true);if(c.status!=='evidence')return c;
   if(p.key.platform==='ios'){
    if(!native.appleOfflineProofRecoverySupported())return {status:'unsupported',reason:'method_missing'};
    const digest=await hash(p);owned();try{const result=await native.assertAppleOfflineKey(p.key.nativeReference,digest);owned();return result;}catch(error){owned();throw error;}
   }
   owned();try{const result=await native.signAndroidCommand(p.key.nativeReference,base64(p.bytes));owned();if(result.status==='evidence'&&!OfflineClockAndroidSignature.safeParse(result.evidence).success)return {status:'invalid',reason:'malformed'};return result;}catch(error){owned();throw error;}
  },
  async release(rawKey:unknown,input:unknown):Promise<NativeIntegrityResult<null>>{
   const p=data(rawKey,input);if(!p)return invalid;const c=capabilities(p);if(c.status!=='evidence')return c;
   if(p.key.platform==='android')return {status:'evidence',evidence:null,verification:'not_verified'};
   if(!native.appleOfflineProofRecoverySupported())return {status:'unsupported',reason:'method_missing'};
   const digest=await hash(p);owned();try{const result=await native.releaseAppleOfflineProof(p.key.nativeReference,digest);owned();return result;}catch(error){owned();throw error;}
  },
 };
}
