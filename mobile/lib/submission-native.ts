/** Encrypted local claims. Opening this store never sends a request or grants server authority. */
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync, CryptoDigestAlgorithm,CryptoEncoding, digest, digestStringAsync, randomUUID } from 'expo-crypto';
import { createSubmissionJournal, SubmissionJournalFull, SubmissionJournalUnavailable, type SubmissionScope } from './submission-journal';
import { createSubmissionStorage,createSealedJournalStorage } from './submission-storage';
import {createEnrollmentJournal,parseEnrollmentSnapshot,EnrollmentScope,EnrollmentJournalUnavailable,type EnrollmentPorts} from './enrollment-journal';
import {createAndroidEnrollmentJournal,parseAndroidEnrollmentSnapshot,type AndroidEnrollmentPorts} from './android-enrollment-journal';
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
      const restored=new File(cache,randomUUID());restored.write(bytes);
      return {uri:restored.uri,name:metadata.name,mimeType:metadata.mimeType,size:metadata.size};
    },
    async deleteEvidence(reference){assertCurrent();const file=new File(directory,evidenceName(reference));if(file.exists)file.delete();},
  });
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
    if(root().exists&&root().list().some(item=>/^(?:android-)?enrollment-/.test(item.name)))throw new EnrollmentJournalUnavailable();
    const id=randomUUID();await SecureStore.setItemAsync(pointer,id,OPTIONS);assertCurrent();return id;
  });
}

/** One encrypted storage owner with distinct protocol AAD/pointers. Legacy Apple bytes keep their
 * original domain; Android cannot interpret or overwrite that journal. Opening performs no send. */
async function nativeEnrollmentStorage<T extends {revision:number;pending:unknown}>(scope:EnrollmentScope,assertCurrent:()=>void,parse:(value:unknown)=>T,domain:'enrollment-v1'|'android-enrollment-v1'){
  assertCurrent();
  const prefix=domain==='enrollment-v1'?'enrollment':'android-enrollment';
  const scopeId=await hash(JSON.stringify([domain,scope.namespace,scope.apiOrigin,scope.actorId,scope.appInstallationId]));assertCurrent();
  const key=await encryptionKey(assertCurrent);assertCurrent();
  const keyId=await hash(await key.encoded('base64'));assertCurrent();
  const pointer=`aihr.${prefix}.${keyId.slice(0,16)}.${scopeId}`,directory=new Directory(root(),`${prefix}-${scopeId}`);
  // Apple retains up to fifteen predecessor contexts beside a 64 KiB attestation (base64 in JSON).
  // Keep that bounded history and one-use proof recoverable together; install-wide quota is unchanged.
  const maximum=domain==='enrollment-v1'?262144:131072;
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
      if(snapshot.pending&&used+Math.max(0,bytes.byteLength-(f.exists?f.size:0))>MAX_INSTALL_BYTES)throw new EnrollmentJournalUnavailable();
      if(!directory.exists)directory.create({intermediates:true});f.write(bytes);
    },
    async seal(bytes){assertCurrent();const result=await aesEncryptAsync(bytes,key,{additionalData:aad});assertCurrent();return result.combined();},
    async open(bytes){assertCurrent();const result=await aesDecryptAsync(AESSealedData.fromCombined(bytes),key,{additionalData:aad});assertCurrent();return result;},
  },{maximumBytes:maximum,refuseOrphanSlots:true,error:()=>new EnrollmentJournalUnavailable()});
  return {
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
