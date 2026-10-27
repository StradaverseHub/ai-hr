/** Bounded platform primitives. Evidence availability is deliberately separate from server verification. */
import {z} from 'zod';
import type {NativeIntegrityModule} from '../modules/aihr-integrity/src/AihrIntegrity.types';
const alias=z.string().length(69).regex(/^aihr_[0-9a-f]{64}$/);
const keyId=z.string().min(1).max(512).refine(value=>!value.includes('\0'));
const sha256=z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/);
const requestHash=z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const blob=(maximum:number)=>z.string().min(4).max(Math.ceil(maximum/3)*4).refine(value=>value.trim()===value).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
  .refine(value=>value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0)<=maximum);
const validNs=(value:string)=>value.trim()===value&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=BigInt('18446744073709551615');
const nanoseconds=z.string().refine(validNs);
/** App-local input only. A transport must use elapsed event durations, never serialize this snapshot. */
export const NativeClockSnapshot=z.object({localOnly:z.literal(true),runtimeId:z.string().uuid(),source:z.enum(['ios_continuous','android_elapsed_realtime']),
  elapsedBeforeNs:nanoseconds,elapsedAfterNs:nanoseconds,wallTimeMs:z.number().finite().min(-8640000000000000).max(8640000000000000),
  bootId:z.string().min(1).max(128).nullable(),
}).strict().refine(value=>validNs(value.elapsedAfterNs)&&validNs(value.elapsedBeforeNs)&&BigInt(value.elapsedAfterNs)>=BigInt(value.elapsedBeforeNs))
  .refine(value=>value.source==='ios_continuous'?value.bootId===null:value.bootId===null||value.bootId.length<=10&&/^(0|[1-9][0-9]*)$/.test(value.bootId)&&value.bootId.trim()===value.bootId&&BigInt(value.bootId)<=BigInt(2147483647));
export type NativeClockSnapshot=z.infer<typeof NativeClockSnapshot>;
export const NativeCapabilities=z.object({version:z.literal(1),platform:z.enum(['ios','android']),appId:z.string().min(1).max(200),
  appVersion:z.string().min(1).max(64),buildVersion:z.string().min(1).max(64),keyMechanism:z.enum(['apple_app_attest','android_keystore','unsupported']),
}).strict().refine(value=>value.keyMechanism==='unsupported'||value.platform==='ios'&&value.keyMechanism==='apple_app_attest'||value.platform==='android'&&value.keyMechanism==='android_keystore');
const AndroidKeyEvidence=z.object({publicKeySpki:blob(2048),certificateChain:z.array(blob(16384)).min(1).max(8),
  reportedSecurityLevel:z.enum(['strongbox','tee','software','hardware_unspecified','unknown']),
}).strict();
const AppleAttestationSnapshot=z.discriminatedUnion('state',[
  z.object({state:z.literal('absent')}).strict(),z.object({state:z.literal('requested')}).strict(),
  z.object({state:z.literal('retryable')}).strict(),z.object({state:z.literal('completed'),attestation:blob(65536)}).strict(),
  z.object({state:z.literal('released')}).strict(),
]);
export const AppleOfflineProofSnapshot=z.discriminatedUnion('state',[
 z.object({state:z.literal('absent')}).strict(),z.object({state:z.literal('requested'),canRetry:z.boolean()}).strict(),
 z.object({state:z.literal('retryable')}).strict(),z.object({state:z.literal('completed'),assertion:blob(8192)}).strict(),
]);
type Reason='bridge_missing'|'method_missing'|'unsupported'|'unavailable'|'server_unavailable'|'invalid_input'|'invalid_key'|'key_exists'|'binding_conflict'|'recovery_required'|'provider_expired'|'obsolete'|'in_progress'|'timeout'|'malformed';
export type NativeIntegrityResult<T>={status:'evidence';evidence:T;verification:'not_verified'}|{status:'unsupported'|'unavailable'|'invalid';reason:Reason};
const codes:Record<string,{status:'unsupported'|'unavailable'|'invalid';reason:Reason}>={
  ERR_INTEGRITY_UNSUPPORTED:{status:'unsupported',reason:'unsupported'},ERR_INTEGRITY_INVALID_INPUT:{status:'invalid',reason:'invalid_input'},
  ERR_INTEGRITY_INVALID_KEY:{status:'invalid',reason:'invalid_key'},ERR_INTEGRITY_KEY_EXISTS:{status:'invalid',reason:'key_exists'},
  ERR_INTEGRITY_PROVIDER_EXPIRED:{status:'unavailable',reason:'provider_expired'},ERR_INTEGRITY_OBSOLETE:{status:'unavailable',reason:'obsolete'},
  ERR_INTEGRITY_SERVER_UNAVAILABLE:{status:'unavailable',reason:'server_unavailable'},ERR_INTEGRITY_IN_PROGRESS:{status:'unavailable',reason:'in_progress'},
  ERR_INTEGRITY_BINDING_CONFLICT:{status:'invalid',reason:'binding_conflict'},ERR_INTEGRITY_RECOVERY_REQUIRED:{status:'unavailable',reason:'recovery_required'},
};
function failure(error:unknown):NativeIntegrityResult<never>{
  let code:unknown;try{code=error&&typeof error==='object'?Reflect.get(error,'code'):null;}catch{}
  return typeof code==='string'&&Object.hasOwn(codes,code)?codes[code]:{status:'unavailable',reason:'unavailable'};
}
/** assertCurrent belongs to the authenticated operation owner; obsolete accounts must fail, not downgrade. */
export function createIntegrityBridge(native:NativeIntegrityModule|null,assertCurrent:()=>void,deadlineMs=20000){
  const timedOut=Symbol('integrity-deadline');
  if(!Number.isFinite(deadlineMs)||deadlineMs<1||deadlineMs>60000)throw new Error('Invalid native integrity deadline');
  function read<T>(method:'capabilities'|'clockSnapshot',schema:z.ZodType<T>):NativeIntegrityResult<T>{
    assertCurrent();if(!native)return {status:'unsupported',reason:'bridge_missing'};
    if(typeof native[method]!=='function')return {status:'unsupported',reason:'method_missing'};
    let result:unknown;try{result=Reflect.apply(native[method],native,[]);}catch(error){assertCurrent();return failure(error);}
    assertCurrent();try{const parsed=schema.safeParse(result);
      return parsed.success?{status:'evidence',evidence:parsed.data,verification:'not_verified'}:{status:'unavailable',reason:'malformed'};
    }catch{assertCurrent();return {status:'unavailable',reason:'malformed'};}
  }
  async function operation<T>(method:keyof NativeIntegrityModule,args:unknown[],schema:z.ZodType<T>):Promise<NativeIntegrityResult<T>>{
    assertCurrent();if(!native)return {status:'unsupported',reason:'bridge_missing'};
    const nativeMethod=native[method];if(typeof nativeMethod!=='function')return {status:'unsupported',reason:'method_missing'};
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const result=await Promise.race([Promise.resolve().then(()=>{assertCurrent();return Reflect.apply(nativeMethod,native,args);}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(timedOut),deadlineMs);})]);
      assertCurrent();const parsed=schema.safeParse(result);
      return parsed.success?{status:'evidence',evidence:parsed.data,verification:'not_verified'}:{status:'unavailable',reason:'malformed'};
    }catch(error){assertCurrent();if(error===timedOut)return {status:'unavailable',reason:'timeout'};return failure(error);}
    finally{clearTimeout(timer);}
  }
  function valid(...results:Array<{success:boolean}>){assertCurrent();return results.every(result=>result.success);}
  const invalid={status:'invalid',reason:'invalid_input'} as const;
  return {
    appleOfflineProofRecoverySupported:()=>{assertCurrent();return typeof native?.appleOfflineProofInfo==='function'&&typeof native?.assertAppleOfflineKey==='function'&&typeof native?.releaseAppleOfflineProof==='function';},
    appleProofRecoverySupported:()=>{assertCurrent();return typeof native?.appleAttestationInfo==='function'&&typeof native?.releaseAppleAttestation==='function'&&typeof native?.resetAppleIntegrityInstallation==='function';},
    capabilities:()=>read('capabilities',NativeCapabilities),clockSnapshot:()=>read('clockSnapshot',NativeClockSnapshot),
    appleKeyInfo:(value:string)=>valid(alias.safeParse(value))?operation('appleKeyInfo',[value],keyId.nullable()):Promise.resolve(invalid),
    generateAppleKey:(value:string)=>valid(alias.safeParse(value))?operation('generateAppleKey',[value],keyId):Promise.resolve(invalid),
    appleAttestationInfo:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('appleAttestationInfo',[id,hash],AppleAttestationSnapshot):Promise.resolve(invalid),
    releaseAppleAttestation:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('releaseAppleAttestation',[id,hash],z.null()):Promise.resolve(invalid),
    resetAppleIntegrityInstallation:()=>operation('resetAppleIntegrityInstallation',[],z.null()),
    attestAppleKey:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('attestAppleKey',[id,hash],blob(65536)):Promise.resolve(invalid),
    appleOfflineProofInfo:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('appleOfflineProofInfo',[id,hash],AppleOfflineProofSnapshot):Promise.resolve(invalid),
    assertAppleOfflineKey:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('assertAppleOfflineKey',[id,hash],blob(8192)):Promise.resolve(invalid),
    releaseAppleOfflineProof:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('releaseAppleOfflineProof',[id,hash],z.null()):Promise.resolve(invalid),
    assertAppleKey:(id:string,hash:string)=>valid(keyId.safeParse(id),sha256.safeParse(hash))?operation('assertAppleKey',[id,hash],blob(8192)):Promise.resolve(invalid),
    createAndroidKey:(value:string,nonce:string,strongBox=false)=>valid(alias.safeParse(value),sha256.safeParse(nonce),z.boolean().safeParse(strongBox))?operation('createAndroidKey',[value,nonce,strongBox],AndroidKeyEvidence):Promise.resolve(invalid),
    androidKeyInfo:(value:string)=>valid(alias.safeParse(value))?operation('androidKeyInfo',[value],AndroidKeyEvidence):Promise.resolve(invalid),
    signAndroidCommand:(value:string,envelope:string)=>valid(alias.safeParse(value),blob(16384).safeParse(envelope))?operation('signAndroidCommand',[value,envelope],blob(128)):Promise.resolve(invalid),
    preparePlayIntegrity:(project:string)=>valid(z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>value.trim()===value&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=BigInt('9223372036854775807')).safeParse(project))?operation('preparePlayIntegrity',[project],z.null()):Promise.resolve(invalid),
    requestPlayIntegrity:(hash:string)=>valid(requestHash.safeParse(hash))?operation('requestPlayIntegrity',[hash],z.string().min(1).max(32768)):Promise.resolve(invalid),
  };
}
