/** Encrypted local claims. Opening this store never sends a request or grants server authority. */
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync, CryptoDigestAlgorithm,CryptoEncoding, digest, digestStringAsync, randomUUID } from 'expo-crypto';
import { createSubmissionJournal, SubmissionJournalFull, SubmissionJournalUnavailable, type SubmissionScope,type EvidenceFile } from './submission-journal';
import { createSubmissionStorage,createSealedJournalStorage } from './submission-storage';
import {createEnrollmentJournal,parseEnrollmentSnapshot,EnrollmentScope,EnrollmentJournalUnavailable,type EnrollmentPorts} from './enrollment-journal';
import {createAndroidEnrollmentJournal,parseAndroidEnrollmentSnapshot,type AndroidEnrollmentPorts} from './android-enrollment-journal';
import {createSignedClockJournal,parseSignedClockSnapshot,type SignedClockSnapshot,type SignedClockPorts} from './signed-clock-journal';
import {OfflineClockClaimData} from '../../lib/mobile-offline-clock';
import {offlineClockPhotoReference,isOfflineCaptureProgress,isOfflineResolution,offlineClaimSettled} from './offline-clock-state';
import NativeIntegrity from '../modules/aihr-integrity/src/AihrIntegrityModule';
import {createIntegrityBridge} from './integrity-bridge';

const KEY='aihr.submissions.key.v1';
const MAX_INSTALL_BYTES=64*1024*1024;
const METADATA_RESERVE=2*65536;
const OPTIONS={keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
let keyWork:Promise<unknown>=Promise.resolve();
function serializedKey<T>(run:()=>Promise<T>){const next=keyWork.then(run);keyWork=next.then(()=>undefined,()=>undefined);return next;}
const root=()=>new Directory(Paths.document,'aihr-submissions-v1');
const hex=(value:ArrayBuffer)=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
const hash=(value:string|Uint8Array)=>typeof value==='string'?digestStringAsync(CryptoDigestAlgorithm.SHA256,value):digest(CryptoDigestAlgorithm.SHA256,new Uint8Array(value)).then(hex);

/** Called only when the app sandbox's installation marker is absent, before any session is restored. */
export function resetSubmissionInstallation(){return serializedKey(async()=>{
  // Only the verified first-install owner calls this. A failed native reset leaves the app marker
  // absent so initialization retries; old/missing bridges cannot start the new enrollment protocol.
  const reset=await createIntegrityBridge(NativeIntegrity,()=>{}).resetAppleIntegrityInstallation();
  if(reset.status!=='evidence'&&reset.status!=='unsupported')throw new SubmissionJournalUnavailable('Native installation cleanup unavailable');
  await SecureStore.deleteItemAsync(KEY,OPTIONS);
  const directory=root();if(directory.exists)directory.delete();
});}
function encryptionKey(assertCurrent:()=>void){return serializedKey(async()=>{
    assertCurrent();const encoded=await SecureStore.getItemAsync(KEY,OPTIONS);assertCurrent();
    if(encoded)return AESEncryptionKey.import(encoded,'base64');
    // A restored filesystem without its device-bound key is quarantined, never treated as empty.
    if(root().exists)throw new SubmissionJournalUnavailable('Submission encryption key is unavailable');
    const generated=await AESEncryptionKey.generate(256);assertCurrent();
    await SecureStore.setItemAsync(KEY,await generated.encoded('base64'),OPTIONS);assertCurrent();return generated;
  });}

export async function openNativeSubmissionJournal(scope:SubmissionScope,assertCurrent:()=>void){
  assertCurrent();
  const scopeId=await hash(JSON.stringify([scope.namespace,scope.actorId,scope.employmentId]));assertCurrent();
  const key=await encryptionKey(assertCurrent);assertCurrent();
  // Keychain can survive reinstall. A new master key must never inherit an old commit pointer.
  const keyId=await hash(await key.encoded('base64'));assertCurrent();
  const pointerKey=`aihr.submissions.${keyId.slice(0,16)}.${scopeId}`;
  const directory=new Directory(root(),scopeId);
  let committedEntryCount=0;
  function ensureDirectory(){if(!directory.exists)directory.create({intermediates:true});}
  function admitBytes(additional:number){
    const used=root().exists?root().size:0;
    if(used==null||!Number.isFinite(used)||used<0)throw new SubmissionJournalUnavailable('Submission storage cannot be inspected');
    if(used+Math.max(0,additional)>MAX_INSTALL_BYTES)throw new SubmissionJournalFull('Pending submission storage is full');
  }
  const aad=(name:string)=>new TextEncoder().encode(`aihr-submissions-v1:${scopeId}:${name}`);
  async function seal(value:Uint8Array,name:string){
    assertCurrent();const result=await aesEncryptAsync(value,key,{additionalData:aad(name)});assertCurrent();return result.combined();
  }
  async function open(value:Uint8Array,name:string){
    assertCurrent();const result=await aesDecryptAsync(AESSealedData.fromCombined(value),key,{additionalData:aad(name)});assertCurrent();return result;
  }
  async function read(name:string,limit:number){
    assertCurrent();const file=new File(directory,name);if(!file.exists)return null;
    if(file.size<1||file.size>limit)throw new SubmissionJournalUnavailable('Invalid encrypted submission');
    const bytes=await file.bytes();assertCurrent();if(bytes.byteLength>limit)throw new SubmissionJournalUnavailable('Invalid encrypted submission');return bytes;
  }
  function evidenceName(reference:string){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sealed$/i.test(reference))throw new SubmissionJournalUnavailable('Invalid evidence reference');
    return reference;
  }
  const storage=createSubmissionStorage(scope,{
    assertCurrent,
    readPointer:()=>SecureStore.getItemAsync(pointerKey,OPTIONS),
    writePointer:value=>SecureStore.setItemAsync(pointerKey,value,OPTIONS),
    readSlot:slot=>read(`journal-${slot}.sealed`,65536+64),
    async writeSlot(slot,bytes,snapshot){
      assertCurrent();const file=new File(directory,`journal-${slot}.sealed`);
      // Resolution must remain possible at the cap; its smaller committed state permits reclamation.
      if(snapshot.entries.length>=committedEntryCount)admitBytes(bytes.byteLength-(file.exists?file.size:0));
      ensureDirectory();file.write(bytes);
    },
    seal:bytes=>seal(bytes,'journal'),open:bytes=>open(bytes,'journal'),
  });
  return createSubmissionJournal(scope,{
    assertCurrent,digest:hash,
    async read(){const snapshot=await storage.read();committedEntryCount=snapshot?.entries.length??0;return snapshot;},
    async commit(snapshot){await storage.commit(snapshot);committedEntryCount=snapshot.entries.length;},
    async reclaim(snapshot){
      assertCurrent();if(!directory.exists)return;
      const retained=new Set(snapshot.entries.flatMap(entry=>entry.evidence?[entry.evidence.reference]:[]));
      if(snapshot.revision)retained.add(`journal-${snapshot.revision%2}.sealed`);
      for(const item of directory.list()){
        assertCurrent();if(!(item instanceof File))continue;
        const name=item.name;
        if((/^journal-[01]\.sealed$/.test(name)||/^[0-9a-f-]{36}\.sealed$/i.test(name))&&!retained.has(name))item.delete();
      }
    },
    async readEvidence(file){
      assertCurrent();const native=new File(file.uri);
      if(!native.exists||native.size!==file.size)throw new SubmissionJournalUnavailable('Pending evidence changed');
      const bytes=await native.bytes();assertCurrent();return bytes;
    },
    async storeEvidence(_kind,_id,bytes){
      const name=`${randomUUID()}.sealed`,encrypted=await seal(bytes,name);assertCurrent();
      admitBytes(encrypted.byteLength+METADATA_RESERVE);ensureDirectory();new File(directory,name).write(encrypted);return name;
    },
    async restoreEvidence(reference,metadata){
      const name=evidenceName(reference),encrypted=await read(name,metadata.size+64);
      if(!encrypted)throw new SubmissionJournalUnavailable('Pending evidence is missing');
      const bytes=await open(encrypted,name);assertCurrent();
      if(bytes.byteLength!==metadata.size)throw new SubmissionJournalUnavailable('Pending evidence changed');
      const cache=new Directory(Paths.cache,'aihr-journeys');if(!cache.exists)cache.create({intermediates:true});
      const restored=new File(cache,randomUUID());try{restored.write(bytes);}catch(error){try{if(restored.exists)restored.delete();}catch{}throw error;}
      return {uri:restored.uri,name:metadata.name,mimeType:metadata.mimeType,size:metadata.size};
    },
    async discardRestored(file){const restored=new File(file.uri);if(restored.exists)restored.delete();},
    async deleteEvidence(reference){assertCurrent();const file=new File(directory,evidenceName(reference));if(file.exists)file.delete();},
  });
}

/** Cleanup only a plaintext file issued by this adapter's restore directory/naming scheme.
 * It must remain possible after session ownership is lost. Encrypted evidence is untouched. */
export function discardNativeSubmissionRestore(file:EvidenceFile){
 const directory=new Directory(Paths.cache,'aihr-journeys'),prefix=directory.uri.replace(/\/$/,'')+'/';
 if(!file.uri.startsWith(prefix)||!(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(file.uri.slice(prefix.length))))return;
 const restored=new File(file.uri);if(restored.exists)restored.delete();
}

/** Installation identity is bound to the device-only master generation. Old Keychain pointers cannot
 * restore another install after the first-install owner resets that master. No network/native SDK call. */
export async function nativeIntegrityInstallationId(assertCurrent:()=>void){
  assertCurrent();const key=await encryptionKey(assertCurrent);assertCurrent();
  const keyId=await hash(await key.encoded('base64'));assertCurrent();
  return serializedKey(async()=>{
    assertCurrent();const pointer=`aihr.enrollment.installation.${keyId.slice(0,16)}`,old=await SecureStore.getItemAsync(pointer,OPTIONS);assertCurrent();
    if(old!==null){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(old))throw new EnrollmentJournalUnavailable();return old.toLowerCase();}
    // Losing this pointer must not select a new, empty scope while old encrypted enrollment work
    // remains. Legacy submission-only installations can still initialize their first enrollment ID.
    if(root().exists&&root().list().some(item=>/^(?:(?:android-)?enrollment|signed-clock)-/.test(item.name)))throw new EnrollmentJournalUnavailable();
    const id=randomUUID();await SecureStore.setItemAsync(pointer,id,OPTIONS);assertCurrent();return id;
  });
}

/** One encrypted storage owner with distinct protocol AAD/pointers. Legacy Apple bytes keep their
 * original domain; Android cannot interpret or overwrite that journal. Opening performs no send. */
async function nativeEnrollmentStorage<T extends {revision:number;pending:unknown}>(scope:EnrollmentScope,assertCurrent:()=>void,parse:(value:unknown)=>T,domain:'enrollment-v1'|'android-enrollment-v1'|'signed-clock-v1',resolving:(snapshot:T)=>boolean=snapshot=>!snapshot.pending){
  assertCurrent();
  const prefix=domain==='enrollment-v1'?'enrollment':domain==='android-enrollment-v1'?'android-enrollment':'signed-clock';
  const scopeId=await hash(JSON.stringify([domain,scope.namespace,scope.apiOrigin,scope.actorId,scope.appInstallationId]));assertCurrent();
  const key=await encryptionKey(assertCurrent);assertCurrent();
  const keyId=await hash(await key.encoded('base64'));assertCurrent();
  const pointer=`aihr.${prefix}.${keyId.slice(0,16)}.${scopeId}`,directory=new Directory(root(),`${prefix}-${scopeId}`);
  // Apple retains predecessor enrollment contexts beside a bounded attestation. The shared clock
  // owner retains up to 32 bounded claim proofs beside its signed context: 1 MiB. Apple enrollment
  // retains 256 KiB, Android enrollment 128 KiB. The install-wide allocation quota is unchanged.
  const maximum=domain==='signed-clock-v1'?1048576:domain==='android-enrollment-v1'?131072:262144;
  const aad=new TextEncoder().encode(`aihr-${domain}:${scopeId}:journal`);
  const file=(slot:0|1)=>new File(directory,`journal-${slot}.sealed`);
  const reclaim=(revision:number)=>{assertCurrent();const old=file((1-revision%2) as 0|1);if(old.exists)old.delete();};
  const storage=createSealedJournalStorage(parse,{
    assertCurrent,
    readPointer:()=>SecureStore.getItemAsync(pointer,OPTIONS),writePointer:value=>SecureStore.setItemAsync(pointer,value,OPTIONS),
    async readSlot(slot){
      assertCurrent();const f=file(slot);if(!f.exists)return null;
      if(f.size<1||f.size>maximum+64)throw new EnrollmentJournalUnavailable();const bytes=await f.bytes();assertCurrent();
      if(bytes.byteLength>maximum+64)throw new EnrollmentJournalUnavailable();return bytes;
    },
    async writeSlot(slot,bytes,snapshot){
      assertCurrent();const f=file(slot),used=root().exists?root().size:0;
      if(used==null||!Number.isFinite(used)||used<0)throw new EnrollmentJournalUnavailable();
      if(!resolving(snapshot)&&used+Math.max(0,bytes.byteLength-(f.exists?f.size:0))>MAX_INSTALL_BYTES)throw new EnrollmentJournalUnavailable();
      if(!directory.exists)directory.create({intermediates:true});f.write(bytes);
    },
    async seal(bytes){assertCurrent();const result=await aesEncryptAsync(bytes,key,{additionalData:aad});assertCurrent();return result.combined();},
    async open(bytes){assertCurrent();const result=await aesDecryptAsync(AESSealedData.fromCombined(bytes),key,{additionalData:aad});assertCurrent();return result;},
  },{maximumBytes:maximum,refuseOrphanSlots:true,error:()=>new EnrollmentJournalUnavailable()});
  function photoMetadata(input:unknown){const photo=OfflineClockClaimData.shape.command.shape.photo.parse(input);if(!photo)throw new EnrollmentJournalUnavailable();return photo;}
  const photoAad=(name:string)=>new TextEncoder().encode(`aihr-${domain}:${scopeId}:photo:${name}`);
  async function readPhoto(requestId:string,input:unknown){
    assertCurrent();if(domain!=='signed-clock-v1')throw new EnrollmentJournalUnavailable();
    const expected=photoMetadata(input),name=offlineClockPhotoReference(requestId),f=new File(directory,name);
    if(!f.exists||f.size<1||f.size>expected.byteLength+64)throw new EnrollmentJournalUnavailable();
    const sealed=await f.bytes();assertCurrent();if(sealed.byteLength>expected.byteLength+64)throw new EnrollmentJournalUnavailable();
    const bytes=await aesDecryptAsync(AESSealedData.fromCombined(sealed),key,{additionalData:photoAad(name)});assertCurrent();
    if(bytes.byteLength!==expected.byteLength||await hash(bytes)!==expected.sha256)throw new EnrollmentJournalUnavailable();assertCurrent();return bytes;
  }
  async function retainPhoto(requestId:string,input:unknown,source:Uint8Array){return serializedKey(async()=>{
    assertCurrent();if(domain!=='signed-clock-v1')throw new EnrollmentJournalUnavailable();
    const expected=photoMetadata(input),name=offlineClockPhotoReference(requestId);
    if(!(source instanceof Uint8Array)||source.byteLength!==expected.byteLength||source.byteLength>2*1024*1024)throw new EnrollmentJournalUnavailable();
    const bytes=new Uint8Array(source);
    if(await hash(bytes)!==expected.sha256)throw new EnrollmentJournalUnavailable();assertCurrent();
    const target=new File(directory,name);
    if(target.exists){await readPhoto(requestId,expected);return name;}
    const result=await aesEncryptAsync(bytes,key,{additionalData:photoAad(name)});assertCurrent();const sealed=await result.combined();assertCurrent();
    const used=root().exists?root().size:0,staged=new File(directory,name+'.staging');
    if(used==null||!Number.isFinite(used)||used<0||used+Math.max(0,sealed.byteLength-(staged.exists?staged.size:0))+2*maximum>MAX_INSTALL_BYTES)throw new SubmissionJournalFull('Pending submission storage is full');
    if(!directory.exists)directory.create({intermediates:true});staged.write(sealed);assertCurrent();
    staged.moveSync(target,{overwrite:false});assertCurrent();await readPhoto(requestId,expected);return name;
  });}
  /** Idempotent: an absent file (already deleted, or never retained) is success. The caller proves the claim settled. */
  async function deletePhoto(requestId:string){return serializedKey(async()=>{
    assertCurrent();if(domain!=='signed-clock-v1')throw new EnrollmentJournalUnavailable();
    const name=offlineClockPhotoReference(requestId);
    for(const f of [new File(directory,name),new File(directory,name+'.staging')])if(f.exists)f.delete();
    assertCurrent();
  });}
  return {
    retainPhoto,readPhoto,deletePhoto,
    async read(){const s=await storage.read();if(s){try{reclaim(s.revision);}catch{/* Preserve the committed state. */}}assertCurrent();return s;},
    async commit(s:T){await storage.commit(s);try{reclaim(s.revision);}catch{/* Preserve the committed receipt. */}assertCurrent();},
    async digest(value:string,encoding:'hex'|'base64'){assertCurrent();const result=await digestStringAsync(CryptoDigestAlgorithm.SHA256,value,{encoding:encoding==='base64'?CryptoEncoding.BASE64:CryptoEncoding.HEX});assertCurrent();return result;},
  };
}
export async function openNativeEnrollmentJournal(rawScope:EnrollmentScope,assertCurrent:()=>void,ports:Omit<EnrollmentPorts,'assertCurrent'|'read'|'commit'|'digest'>){
  const scope=EnrollmentScope.parse(rawScope),storage=await nativeEnrollmentStorage(scope,assertCurrent,value=>parseEnrollmentSnapshot(value,scope),'enrollment-v1');
  return createEnrollmentJournal(scope,{...ports,assertCurrent,...storage});
}
export async function openNativeAndroidEnrollmentJournal(rawScope:EnrollmentScope,assertCurrent:()=>void,ports:Omit<AndroidEnrollmentPorts,'assertCurrent'|'read'|'commit'|'digest'>){
  const scope=EnrollmentScope.parse(rawScope),storage=await nativeEnrollmentStorage(scope,assertCurrent,value=>parseAndroidEnrollmentSnapshot(value,scope),'android-enrollment-v1');
  return createAndroidEnrollmentJournal(scope,{...ports,assertCurrent,...storage});
}

/** One installed-account lease across employments; no proof or network action while opening. */
export async function openNativeSignedClockJournal(rawScope:EnrollmentScope,assertCurrent:()=>void,ports:Omit<SignedClockPorts,'assertCurrent'|'read'|'commit'>){
 const scope=EnrollmentScope.parse(rawScope);let prior:SignedClockSnapshot|null=null;
 const storage=await nativeEnrollmentStorage(scope,assertCurrent,value=>parseSignedClockSnapshot(value,scope),'signed-clock-v1',
  snapshot=>(!snapshot.pending&&!snapshot.offline)||snapshot.pending?.phase==='settled'||!snapshot.pending&&(isOfflineCaptureProgress(prior?.offline,snapshot.offline)||isOfflineResolution(prior?.offline,snapshot.offline)));
 const read=async()=>{const value=await storage.read();prior=value;return value;};
 const commit=async(value:SignedClockSnapshot)=>{await storage.commit(value);prior=value;};
 const journal=createSignedClockJournal(scope,{...ports,assertCurrent,read,commit});
 async function checkPhoto(requestId:string,input:unknown,reading=false){
  const state=await read();assertCurrent();const exchange=state?.offline;
  if(!exchange||exchange.phase!=='context_ready')throw new EnrollmentJournalUnavailable();
  const name=offlineClockPhotoReference(requestId),entry=exchange.claims.find(value=>value.photoReference===name);
  if(!entry||reading&&entry.phase==='capture_requested'||JSON.stringify(OfflineClockClaimData.shape.command.shape.photo.parse(input))!==JSON.stringify(entry.claim.command.photo))throw new EnrollmentJournalUnavailable();
 }
 return {...journal,
  async retainOfflinePhoto(requestId:string,input:unknown,bytes:Uint8Array){try{await checkPhoto(requestId,input);const result=await storage.retainPhoto(requestId,input,bytes);assertCurrent();return result;}catch(error){assertCurrent();throw error;}},
  async readOfflinePhoto(requestId:string,input:unknown){try{await checkPhoto(requestId,input,true);const result=await storage.readPhoto(requestId,input);assertCurrent();return result;}catch(error){assertCurrent();throw error;}},
  /** Guarded like checkPhoto: only the photo of a committed claim that is settled (its receipt saved, or the employee's
   * confirmed removal of an undeliverable claim) in this account's own exchange. */
  async deleteOfflinePhoto(requestId:string){try{
   const state=await read();assertCurrent();const exchange=state?.offline,name=offlineClockPhotoReference(requestId);
   if(!exchange||exchange.phase==='context_requested')throw new EnrollmentJournalUnavailable();
   const entry=exchange.claims.find(value=>value.photoReference===name);
   if(!entry||!offlineClaimSettled(entry))throw new EnrollmentJournalUnavailable();
   await storage.deletePhoto(requestId);assertCurrent();
  }catch(error){assertCurrent();throw error;}},
 };

}

/** Small device-only records sealed under the installation master (offline identity anchor, issuer registry cache).
 * SecureStore item size limits are UNKNOWN, so these live as sealed files beside the journals. Staged then moved into
 * place; an unreadable or tampered record reads as unavailable, never as another account's data. */
export type SealedDeviceRecord='offline-anchor'|'offline-issuers';
const RECORD_LIMIT=16384;
const recordFile=(name:SealedDeviceRecord)=>new File(root(),`${name}.sealed`);
const recordAad=(name:SealedDeviceRecord)=>new TextEncoder().encode(`aihr-device-record-v1:${name}`);
export async function readSealedDeviceRecord(name:SealedDeviceRecord,assertCurrent:()=>void):Promise<unknown>{
  assertCurrent();const f=recordFile(name);if(!f.exists)return null;
  if(f.size<1||f.size>RECORD_LIMIT+64)throw new SubmissionJournalUnavailable('Invalid device record');
  const key=await encryptionKey(assertCurrent),sealed=await f.bytes();assertCurrent();
  const bytes=await aesDecryptAsync(AESSealedData.fromCombined(sealed),key,{additionalData:recordAad(name)});assertCurrent();
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}
export async function writeSealedDeviceRecord(name:SealedDeviceRecord,value:unknown,assertCurrent:()=>void){
  assertCurrent();const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.byteLength>RECORD_LIMIT)throw new SubmissionJournalUnavailable('Device record too large');
  const key=await encryptionKey(assertCurrent),result=await aesEncryptAsync(bytes,key,{additionalData:recordAad(name)});assertCurrent();const sealed=await result.combined();assertCurrent();
  return serializedKey(async()=>{
    assertCurrent();const directory=root(),target=recordFile(name),staged=new File(directory,`${name}.sealed.staging`);
    const used=directory.exists?directory.size:0;
    if(used==null||!Number.isFinite(used)||used<0||used+sealed.byteLength>MAX_INSTALL_BYTES)throw new SubmissionJournalFull('Pending submission storage is full');
    if(!directory.exists)directory.create({intermediates:true});staged.write(sealed);assertCurrent();
    staged.moveSync(target,{overwrite:true});assertCurrent();
  });
}
/** Synchronous file removal: usable from logout after session ownership is gone. Encrypted journals are untouched. */
export function deleteSealedDeviceRecord(name:SealedDeviceRecord){
  for(const f of [recordFile(name),new File(root(),`${name}.sealed.staging`)])if(f.exists)f.delete();
}
