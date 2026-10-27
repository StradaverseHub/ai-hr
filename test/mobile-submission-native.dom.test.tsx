import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as journal from '../mobile/lib/submission-journal';
import * as storage from '../mobile/lib/submission-storage';
import * as enrollment from '../mobile/lib/enrollment-journal';
import * as androidEnrollment from '../mobile/lib/android-enrollment-journal';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';
import {enrollmentFixture,enrollmentId} from './helpers/mobile-enrollment-fixture';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {createInstallationStore} from '../mobile/lib/installation-store';

/** Execute the shipped native adapter. Files/Keychain/native AES are ports; AES-GCM uses real crypto. */
function fixture(nativeAvailable=true){
  const files=new Map<string,Uint8Array>(),directories=new Set<string>(),secrets=new Map<string,string>();
  let occupiedBytes=0;
  const nativeReset={resetAppleIntegrityInstallation:vi.fn<()=>Promise<unknown>>(async()=>null)};
  const uri=(...parts:unknown[])=>parts.map(p=>typeof p==='string'?p:(p as {uri:string}).uri).join('/');
  class Directory {
    uri:string;constructor(...parts:unknown[]){this.uri=uri(...parts);}
    get exists(){return directories.has(this.uri);}
    get size(){return occupiedBytes+[...files].filter(([path])=>path.startsWith(this.uri+'/')).reduce((total,[,bytes])=>total+bytes.byteLength,0);}
    list(){return [...files.keys()].filter(path=>path.startsWith(this.uri+'/')&&!path.slice(this.uri.length+1).includes('/')).map(path=>new File(path));}
    create(){directories.add(this.uri);directories.add('document/aihr-submissions-v1');}
    delete(){for(const key of directories)if(key.startsWith(this.uri))directories.delete(key);for(const key of files.keys())if(key.startsWith(this.uri+'/'))files.delete(key);}
  }
  class File {
    uri:string;constructor(...parts:unknown[]){this.uri=uri(...parts);}
    get exists(){return files.has(this.uri);}
    get size(){return files.get(this.uri)?.byteLength??0;}
    get name(){return this.uri.split('/').at(-1)!;}
    async bytes(){return files.get(this.uri)!.slice();}
    write(value:Uint8Array){files.set(this.uri,value.slice());}
    delete(){files.delete(this.uri);}
  }
  const secure={WHEN_UNLOCKED_THIS_DEVICE_ONLY:'device-unlocked',
    getItemAsync:vi.fn(async(key:string)=>secrets.get(key)??null),
    setItemAsync:vi.fn(async(key:string,value:string)=>{secrets.set(key,value);}),
    deleteItemAsync:vi.fn(async(key:string)=>{secrets.delete(key);})};
  const crypto={randomUUID,CryptoDigestAlgorithm:{SHA256:'sha256'},CryptoEncoding:{HEX:'hex',BASE64:'base64'},
    digestStringAsync:async(_:string,value:string,options?:{encoding:'hex'|'base64'})=>createHash('sha256').update(value).digest(options?.encoding??'hex'),
    digest:async(_:string,value:Uint8Array)=>Uint8Array.from(createHash('sha256').update(value).digest()).buffer,
    AESEncryptionKey:{generate:async()=>key(randomBytes(32)),import:async(encoded:string)=>key(Buffer.from(encoded,'base64'))},
    AESSealedData:{fromCombined:(bytes:Uint8Array)=>bytes},
    async aesEncryptAsync(plaintext:Uint8Array,k:{bytes:Buffer},options:{additionalData:Uint8Array}){
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k.bytes,nonce);cipher.setAAD(options.additionalData);
      const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      return {combined:async()=>Uint8Array.from(Buffer.concat([nonce,ciphertext,cipher.getAuthTag()]))};
    },
    async aesDecryptAsync(sealed:Uint8Array,k:{bytes:Buffer},options:{additionalData:Uint8Array}){
      const bytes=Buffer.from(sealed),decipher=createDecipheriv('aes-256-gcm',k.bytes,bytes.subarray(0,12));
      decipher.setAAD(options.additionalData);decipher.setAuthTag(bytes.subarray(-16));
      return Uint8Array.from(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]));
    },
  };
  function key(bytes:Buffer){return {bytes,encoded:async()=>bytes.toString('base64')};}
  // Keep native global declarations out of the server compiler; execute its implementation via VM.
  const output={exports:{} as {
    openNativeSubmissionJournal:(scope:journal.SubmissionScope,assertCurrent:()=>void)=>Promise<ReturnType<typeof journal.createSubmissionJournal>>;
    resetSubmissionInstallation:()=>Promise<void>;
    nativeIntegrityInstallationId:(assertCurrent:()=>void)=>Promise<string>;
    openNativeEnrollmentJournal:(scope:enrollment.EnrollmentScope,assertCurrent:()=>void,ports:Omit<enrollment.EnrollmentPorts,'assertCurrent'|'read'|'commit'|'digest'>)=>Promise<ReturnType<typeof enrollment.createEnrollmentJournal>>;
    openNativeAndroidEnrollmentJournal:(scope:enrollment.EnrollmentScope,assertCurrent:()=>void,ports:Omit<androidEnrollment.AndroidEnrollmentPorts,'assertCurrent'|'read'|'commit'|'digest'>)=>Promise<ReturnType<typeof androidEnrollment.createAndroidEnrollmentJournal>>;
  }};
  const code=transpileModule(readFileSync('mobile/lib/submission-native.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,{exports:output.exports,module:output,Uint8Array,TextEncoder,TextDecoder,require:(id:string)=>{
    if(id==='expo-file-system')return {Directory,File,Paths:{document:'document',cache:'cache'}};
    if(id==='expo-secure-store')return secure;if(id==='expo-crypto')return crypto;
    if(id==='../modules/aihr-integrity/src/AihrIntegrityModule')return {default:nativeAvailable?nativeReset:null};
    if(id==='./integrity-bridge')return {createIntegrityBridge};
    if(id==='./submission-journal')return journal;if(id==='./submission-storage')return storage;if(id==='./enrollment-journal')return enrollment;if(id==='./android-enrollment-journal')return androidEnrollment;throw new Error(id);
  }});
  return {native:output.exports,files,directories,secrets,secure,nativeReset,occupy:(bytes:number)=>{occupiedBytes=bytes;}};
}
const scope={namespace:'https://hr.example.com',actorId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employmentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const command=JSON.stringify({requestId,action:'in',lat:3,lng:101,accuracy:5,sampledAt:Date.now()});
describe('native encrypted submission adapter',()=>{
  it('seals Android enrollment through restart with a separate Apple pointer/AAD and no creation on open',async()=>{
    const f=fixture(),a=androidEnrollmentFixture(),apple=enrollmentFixture();
    const opened=await f.native.openNativeAndroidEnrollmentJournal(a.scope,a.ports.assertCurrent,a.ports);expect(a.native.create).not.toHaveBeenCalled();expect(a.ports.prepare).not.toHaveBeenCalled();
    await opened.begin(a.employmentId,a.requestId);expect(await opened.advance(a.employmentId)).toMatchObject({status:'stored_key'});
    const restarted=await f.native.openNativeAndroidEnrollmentJournal(a.scope,a.ports.assertCurrent,a.ports);expect(await restarted.status()).toMatchObject({status:'stored_key'});expect(a.native.create).toHaveBeenCalledOnce();
    for(const bytes of f.files.values())expect(Buffer.from(bytes).toString()).not.toContain(a.requestId);
    const old=await f.native.openNativeEnrollmentJournal({...apple.scope,...a.scope},apple.ports.assertCurrent,apple.ports);expect(await old.status()).toEqual({status:'empty'});
    expect([...f.secrets.keys()].some(key=>key.startsWith('aihr.android-enrollment.'))).toBe(true);
  });
  it('refuses an Android orphan pointer and prevents Apple/Android ciphertext transplantation',async()=>{
    const f=fixture(),a=androidEnrollmentFixture(),apple=enrollmentFixture(),shared={...apple.scope,...a.scope};
    await (await f.native.openNativeAndroidEnrollmentJournal(shared,a.ports.assertCurrent,a.ports)).begin(a.employmentId,a.requestId);
    await (await f.native.openNativeEnrollmentJournal(shared,apple.ports.assertCurrent,apple.ports)).begin(apple.employmentId,apple.requestId);
    const androidPath=[...f.files.keys()].find(path=>path.includes('/android-enrollment-'))!,applePath=[...f.files.keys()].find(path=>path.includes('/enrollment-'))!;
    expect(androidPath).toBeTruthy();expect(applePath).toBeTruthy();f.files.set(androidPath,f.files.get(applePath)!);
    await expect((await f.native.openNativeAndroidEnrollmentJournal(shared,a.ports.assertCurrent,a.ports)).status()).rejects.toBeInstanceOf(enrollment.EnrollmentJournalUnavailable);
    const pointer=[...f.secrets.keys()].find(key=>key.startsWith('aihr.android-enrollment.'))!;f.secrets.delete(pointer);
    await expect((await f.native.openNativeAndroidEnrollmentJournal(shared,a.ports.assertCurrent,a.ports)).status()).rejects.toBeInstanceOf(enrollment.EnrollmentJournalUnavailable);
  });
  it('retries failed native first-install cleanup before marking the installation, without clearing data on logout',async()=>{
    const f=fixture(),e=enrollmentFixture(),pending=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);await pending.begin(e.employmentId,e.requestId);
    let marker=false,logout=false;const events:string[]=[];
    const ports={markerExists:()=>marker,logoutPending:()=>logout,createMarker:()=>{events.push('marker');marker=true;logout=false;},
      read:async()=>{events.push('read');return null;},write:async()=>{},remove:async()=>{events.push('credentials');},resetPrivateData:f.native.resetSubmissionInstallation};
    f.nativeReset.resetAppleIntegrityInstallation.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});
    const store=createInstallationStore(ports);await expect(store.read()).rejects.toThrow();
    expect(marker).toBe(false);expect(f.secrets.has('aihr.submissions.key.v1')).toBe(true);expect(f.files.size).toBe(1);
    await store.read();expect(events).toEqual(['credentials','credentials','marker','read']);expect(f.files.size).toBe(0);expect(f.secrets.has('aihr.submissions.key.v1')).toBe(false);
    const current=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);await current.begin(e.employmentId,e.requestId);
    logout=true;await createInstallationStore(ports).read();expect(f.nativeReset.resetAppleIntegrityInstallation).toHaveBeenCalledTimes(2);expect(f.files.size).toBe(1);
  });
  it('keeps legacy initialization available without an optional native bridge, and refuses malformed cleanup acknowledgement',async()=>{
    const old=fixture(false);await old.native.resetSubmissionInstallation();expect(old.nativeReset.resetAppleIntegrityInstallation).not.toHaveBeenCalled();
    const f=fixture(),e=enrollmentFixture(),opened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);await opened.begin(e.employmentId,e.requestId);
    f.nativeReset.resetAppleIntegrityInstallation.mockResolvedValueOnce({cleared:true});await expect(f.native.resetSubmissionInstallation()).rejects.toThrow();
    expect(f.files.size).toBe(1);expect(f.secrets.has('aihr.submissions.key.v1')).toBe(true);
  });
  it('persists revocation intent encrypted across reopening without touching an attendance command',async()=>{
    const f=fixture(),e=enrollmentFixture();
    const clock=await f.native.openNativeSubmissionJournal(scope,()=>{});await clock.stage('clock',command);
    const journal=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    await journal.begin(e.employmentId,e.requestId);await journal.advance(e.employmentId);
    vi.mocked(e.ports.revoke).mockRejectedValueOnce(new Error('reply lost'));
    await expect(journal.revoke(e.employmentId)).rejects.toThrow('reply lost');
    const reopened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    expect(await reopened.status()).toMatchObject({status:'revocation_pending'});
    expect((await clock.pending())[0].command).toBe(command);
    expect(await reopened.revoke(e.employmentId)).toMatchObject({status:'stored_key',revoked:true});
    expect((await clock.pending())[0].command).toBe(command);
  });
  it('keeps enrollment identity stable within one master generation and changes it after installation reset',async()=>{
    const f=fixture(),first=await f.native.nativeIntegrityInstallationId(()=>{});
    expect(await f.native.nativeIntegrityInstallationId(()=>{})).toBe(first);
    await f.native.resetSubmissionInstallation();expect(await f.native.nativeIntegrityInstallationId(()=>{})).not.toBe(first);
  });
  it('encrypts enrollment context and proof, survives restart and clears proof only after server receipt commit',async()=>{
    const f=fixture(),e=enrollmentFixture();
    const opened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    await opened.begin(e.employmentId,e.requestId);
    vi.mocked(e.ports.complete).mockRejectedValueOnce(new Error('response unavailable'));
    await expect(opened.advance(e.employmentId)).rejects.toThrow('response unavailable');
    const bytes=[...f.files].filter(([name])=>name.startsWith('document/'));
    expect(bytes).toHaveLength(1);
    for(const [,value] of bytes){expect(Buffer.from(value).toString()).not.toContain(e.attestation);expect(Buffer.from(value).toString()).not.toContain(e.requestId);}
    const restarted=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    expect(await restarted.status()).toMatchObject({phase:'proof_ready',requestId:e.requestId});
    expect((await restarted.advance(e.employmentId)).status).toBe('stored_key');
    expect(e.native.attestAppleKey).toHaveBeenCalledOnce();
    expect([...f.files].filter(([name])=>name.startsWith('document/'))).toHaveLength(1);
    expect(f.secure.setItemAsync).toHaveBeenCalledWith(expect.any(String),expect.any(String),{keychainAccessible:'device-unlocked'});
  });
  it('refuses missing enrollment pointers/slots, tampered ciphertext and cross-actor slot transplants',async()=>{
    for(const fault of ['pointer','slot','tamper','transplant'] as const){
      const f=fixture(),e=enrollmentFixture(),opened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
      await opened.begin(e.employmentId,e.requestId);
      const path=[...f.files.keys()].find(name=>name.startsWith('document/'))!,pointer=[...f.secrets.keys()].find(name=>name.startsWith('aihr.enrollment.'))!;
      let scope=e.scope;
      if(fault==='pointer')f.secrets.delete(pointer);if(fault==='slot')f.files.delete(path);if(fault==='tamper')f.files.get(path)![15]^=1;
      if(fault==='transplant'){
        scope={...scope,actorId:enrollmentId(9)};const foreign=await f.native.openNativeEnrollmentJournal(scope,e.ports.assertCurrent,e.ports);await foreign.begin(e.employmentId,e.requestId);
        const other=[...f.files.keys()].find(name=>name.startsWith('document/')&&name!==path)!;f.files.set(other,f.files.get(path)!.slice());
      }
      const restarted=await f.native.openNativeEnrollmentJournal(scope,e.ports.assertCurrent,e.ports);
      await expect(restarted.status()).rejects.toThrow();expect(e.native.generateAppleKey).not.toHaveBeenCalled();
    }
  });
  it('keeps the full permitted proof encrypted above the old metadata limit and releases its JS copy only on receipt',async()=>{
    const f=fixture(),e=enrollmentFixture(),proof=Buffer.alloc(65536,255).toString('base64');
    e.native.attestAppleKey.mockResolvedValueOnce(proof);vi.mocked(e.ports.complete).mockRejectedValueOnce(new Error('no server response'));
    const opened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);await opened.begin(e.employmentId,e.requestId);
    await expect(opened.advance(e.employmentId)).rejects.toThrow('no server response');
    expect([...f.files.values()].some(value=>value.byteLength>65536)).toBe(true);
    const restarted=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    expect((await restarted.advance(e.employmentId)).status).toBe('stored_key');
    expect(vi.mocked(e.ports.complete).mock.calls[1][1].attestation).toBe(proof);expect(e.native.attestAppleKey).toHaveBeenCalledOnce();
    expect([...f.files.values()].every(value=>value.byteLength<65536)).toBe(true);
  });
  it('re-reads an ambiguously committed intent instead of caching empty state or choosing a new request',async()=>{
    const f=fixture(),e=enrollmentFixture(),opened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    f.secure.setItemAsync.mockImplementationOnce(async(key,value)=>{f.secrets.set(key,value);throw new Error('secure write reply lost');});
    await expect(opened.begin(e.employmentId,e.requestId)).rejects.toThrow();
    expect(await opened.status()).toMatchObject({phase:'requested',requestId:e.requestId});
    expect(await opened.begin(e.employmentId,enrollmentId(9))).toMatchObject({requestId:e.requestId});
    expect(e.native.generateAppleKey).not.toHaveBeenCalled();expect(e.ports.prepare).not.toHaveBeenCalled();
  });
  it('retains the preparation if command adoption loses its secure commit pointer',async()=>{
    const f=fixture();f.files.set('photo',new Uint8Array([7,8,9]));
    const opened=await f.native.openNativeSubmissionJournal(scope,()=>{}),entry=await opened.prepareClock('in',requestId);
    f.secure.setItemAsync.mockRejectedValueOnce(new Error('Commit failed'));
    await expect(opened.stage('clock',command,{uri:'photo',name:'photo',mimeType:'image/jpeg',size:3})).rejects.toThrow('Commit failed');
    const restarted=await f.native.openNativeSubmissionJournal(scope,()=>{});expect(await restarted.pending()).toEqual([entry]);
    expect((await restarted.restore(entry)).command).toBe(entry.command);
    expect([...f.files.keys()].filter(path=>path.startsWith('document/'))).toHaveLength(1);
  });
  it('keeps an encrypted unsent attempt through restart and never replaces a missing committed slot with empty state',async()=>{
    const f=fixture(),opened=await f.native.openNativeSubmissionJournal(scope,()=>{}),entry=await opened.prepareClock('in',requestId);
    const restarted=await f.native.openNativeSubmissionJournal(scope,()=>{});expect(await restarted.pending()).toEqual([entry]);
    for(const [path,bytes]of f.files)if(path.startsWith('document/'))expect(new TextDecoder().decode(bytes)).not.toContain(requestId);
    const committed=[...f.files.keys()].find(path=>path.endsWith('journal-1.sealed'))!;expect(committed).toBeTruthy();f.files.delete(committed);
    await expect((await f.native.openNativeSubmissionJournal(scope,()=>{})).pending()).rejects.toThrow('Missing submission journal');
  });
  it('reclaims uncommitted encrypted orphans on restart without losing a committed claim',async()=>{
    const f=fixture();f.files.set('photo',new Uint8Array([7,8,9]));const opened=await f.native.openNativeSubmissionJournal(scope,()=>{});
    f.secure.setItemAsync.mockRejectedValueOnce(new Error('Commit failed'));
    await expect(opened.stage('clock',command,{uri:'photo',name:'photo',mimeType:'image/jpeg',size:3})).rejects.toThrow('Commit failed');
    expect([...f.files.keys()].filter(path=>path.startsWith('document/'))).toHaveLength(2);
    const restarted=await f.native.openNativeSubmissionJournal(scope,()=>{});expect(await restarted.pending()).toEqual([]);
    expect([...f.files.keys()].filter(path=>path.startsWith('document/'))).toHaveLength(0);
    const entry=await restarted.stage('clock',command,{uri:'photo',name:'photo',mimeType:'image/jpeg',size:3});
    const again=await f.native.openNativeSubmissionJournal(scope,()=>{});expect(await again.pending()).toEqual([entry]);
    expect((await again.restore(entry)).command).toBe(command);
  });
  it('refuses new evidence at the installation cap but still allows pending resolution and cleanup',async()=>{
    const f=fixture();f.files.set('photo',new Uint8Array([7,8,9]));const opened=await f.native.openNativeSubmissionJournal(scope,()=>{});
    await opened.stage('clock',command,{uri:'photo',name:'photo',mimeType:'image/jpeg',size:3});
    f.occupy(64*1024*1024);await opened.resolve('clock',requestId);expect(await opened.pending()).toEqual([]);
    await expect(opened.stage('clock',command,{uri:'photo',name:'photo',mimeType:'image/jpeg',size:3})).rejects.toBeInstanceOf(journal.SubmissionJournalFull);
    expect([...f.files.keys()].filter(path=>path.startsWith('document/'))).toHaveLength(1);
  });
  it('persists encrypted metadata and evidence and restores the same bytes after restart',async()=>{
    const f=fixture();f.files.set('photo',new Uint8Array([7,8,9]));
    const opened=await f.native.openNativeSubmissionJournal(scope,()=>{});
    const entry=await opened.stage('clock',command,{uri:'photo',name:'private-photo.jpg',mimeType:'image/jpeg',size:3});
    const sealed=[...f.files].filter(([path])=>path.startsWith('document/'));
    expect(sealed).toHaveLength(2);
    for(const [,bytes]of sealed){expect(Buffer.from(bytes).toString()).not.toContain('private-photo');expect(Buffer.from(bytes).toString()).not.toContain(requestId);}
    expect([...f.secrets.values()]).not.toContain(command);
    const restarted=await f.native.openNativeSubmissionJournal(scope,()=>{});
    expect(await restarted.pending()).toEqual([entry]);
    const restored=await restarted.restore(entry);expect(restored.command).toBe(command);
    expect(f.files.get(restored.file!.uri)).toEqual(new Uint8Array([7,8,9]));
    expect(f.secure.setItemAsync).toHaveBeenCalledWith(expect.any(String),expect.any(String),{keychainAccessible:'device-unlocked'});
  });
  it('authenticates both metadata and evidence against tampering',async()=>{
    const f=fixture();f.files.set('photo',new Uint8Array([7,8,9]));
    const opened=await f.native.openNativeSubmissionJournal(scope,()=>{}),entry=await opened.stage('clock',command,{uri:'photo',name:'photo',mimeType:'image/jpeg',size:3});
    const evidence=[...f.files.keys()].find(p=>p.endsWith(entry.evidence!.reference))!;
    f.files.get(evidence)![15]^=1;
    await expect(opened.restore(entry)).rejects.toThrow();
    const metadata=[...f.files.keys()].find(p=>p.endsWith('journal-1.sealed'))!;
    f.files.get(metadata)![15]^=1;
    const restarted=await f.native.openNativeSubmissionJournal(scope,()=>{});
    await expect(restarted.pending()).rejects.toThrow('cannot be opened');
  });
  it('quarantines restored files when their device-bound key is missing',async()=>{
    const f=fixture(),opened=await f.native.openNativeSubmissionJournal(scope,()=>{});await opened.stage('clock',command);
    f.secrets.delete('aihr.submissions.key.v1');
    await expect(f.native.openNativeSubmissionJournal(scope,()=>{})).rejects.toThrow('encryption key is unavailable');
  });
  it('does not inherit a surviving Keychain pointer after installation reset',async()=>{
    const f=fixture(),opened=await f.native.openNativeSubmissionJournal(scope,()=>{});await opened.stage('clock',command);
    await f.native.resetSubmissionInstallation();
    expect(await (await f.native.openNativeSubmissionJournal(scope,()=>{})).pending()).toEqual([]);
  });
  it('keeps another actor empty and rejects copied encrypted slots',async()=>{
    const f=fixture(),opened=await f.native.openNativeSubmissionJournal(scope,()=>{});await opened.stage('clock',command);
    const other=await f.native.openNativeSubmissionJournal({...scope,actorId:scope.employmentId},()=>{});
    expect(await other.pending()).toEqual([]);
    // A valid ciphertext under the same master key cannot be transplanted to another scope.
    await other.stage('clock',command);
    const paths=[...f.files.keys()].filter(p=>p.endsWith('journal-1.sealed'));
    expect(paths).toHaveLength(2);f.files.set(paths[1],f.files.get(paths[0])!);
    const restarted=await f.native.openNativeSubmissionJournal({...scope,actorId:scope.employmentId},()=>{});
    await expect(restarted.pending()).rejects.toThrow('cannot be opened');
  });
});
