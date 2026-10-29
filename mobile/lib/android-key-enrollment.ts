/** Native enrollment operations only. Durable journal/reconciliation and upload remain caller-owned. */
import {AndroidEnrollmentPreparation,AndroidEnrollmentKeyArtifact} from '../../lib/mobile-android-enrollment';
import {androidEnrollmentClientDataHash,androidEnrollmentAlias} from './android-enrollment-integrity';
import type {createIntegrityBridge,NativeIntegrityResult} from './integrity-bridge';
import {UnavailableError} from './errors';
type Prepared=ReturnType<typeof AndroidEnrollmentPreparation.parse>;
type Bridge=ReturnType<typeof createIntegrityBridge>;
type Evidence=Extract<Awaited<ReturnType<Bridge['androidKeyInfo']>>,{status:'evidence'}>['evidence'];
const invalid={status:'invalid',reason:'invalid_input'} as const;
/** Reading never creates. Creating never reads/replaces an existing key or retries a failed SDK call.
 * persistGenerationIntent MUST durably retain the prepared reference before returning. A caller with
 * uncertain generation state reconciles its exact server receipt and then reads the saved alias. */
export function createAndroidKeyEnrollment(native:Bridge,assertCurrent:()=>void,isForeground:()=>boolean){
 const owned=()=>{assertCurrent();if(!isForeground())throw new UnavailableError('Unlock the app to continue.');};
 async function ownedCall<T>(operation:()=>Promise<T>){owned();try{const result=await operation();owned();return result;}catch(error){owned();throw error;}}
 async function prepare(input:unknown,creating:boolean):Promise<{prepared:Prepared;strongBox:boolean}|NativeIntegrityResult<never>>{
  owned();const parsed=AndroidEnrollmentPreparation.safeParse(input);if(!parsed.success)return invalid;
  const p=parsed.data,capability=native.capabilities();owned();if(capability.status!=='evidence')return capability;
  if(capability.evidence.platform!=='android'||capability.evidence.keyMechanism!=='android_keystore')return {status:'unsupported',reason:'unsupported'};
  if(capability.evidence.appId!==p.context.target.packageName||creating&&(p.state!=='active'||!p.context.target.versionCodes.includes(capability.evidence.buildVersion)))return invalid;
  const digest=await ownedCall(()=>androidEnrollmentClientDataHash(p.context,owned));
  if(digest!==p.clientDataHash)return invalid;
  const alias=await ownedCall(()=>androidEnrollmentAlias(p.context,owned));if(alias!==p.alias)return invalid;
  return {prepared:p,strongBox:p.context.target.securityLevels.length===1&&p.context.target.securityLevels[0]==='strongbox'};
 }
 function bounded(result:NativeIntegrityResult<Evidence>):NativeIntegrityResult<Evidence>{
  if(result.status!=='evidence')return result;
  const p=result.evidence;
  if(!AndroidEnrollmentKeyArtifact.safeParse({publicKeySpki:p.publicKeySpki,certificateChain:p.certificateChain}).success)return {status:'unsupported',reason:'unsupported'};
  return result;
 }
 return {
  async read(input:unknown):Promise<NativeIntegrityResult<Evidence>>{
   const checked=await prepare(input,false);if(!('prepared' in checked))return checked;
   return bounded(await ownedCall(()=>native.androidKeyInfo(checked.prepared.alias)));
  },
  async create(input:unknown,persistGenerationIntent:(prepared:Prepared)=>Promise<void>):Promise<NativeIntegrityResult<Evidence>>{
   const checked=await prepare(input,true);if(!('prepared' in checked))return checked;
   await ownedCall(()=>persistGenerationIntent(structuredClone(checked.prepared)));
   return bounded(await ownedCall(()=>native.createAndroidKey(checked.prepared.alias,checked.prepared.clientDataHash,checked.strongBox)));
  },
 };
}
