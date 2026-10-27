import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as journal from '../mobile/lib/submission-journal';
import {OfflineClockClaimData} from '../lib/mobile-offline-clock';
import * as offlineState from '../mobile/lib/offline-clock-state';
import {offlineContextIssuerIdentity,signOfflineClockContext,verifyOfflineClockContextSignature} from '../lib/mobile-api/offline-context-signature';
import type {OfflineClockContextData} from '../lib/mobile-offline-context';
import * as signedClock from '../mobile/lib/signed-clock-journal';
import * as storage from '../mobile/lib/submission-storage';
import * as enrollment from '../mobile/lib/enrollment-journal';
import * as androidEnrollment from '../mobile/lib/android-enrollment-journal';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';
import {enrollmentFixture,enrollmentId} from './helpers/mobile-enrollment-fixture';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {createInstallationStore} from '../mobile/lib/installation-store';
import {appleReplacementFixture} from './helpers/mobile-apple-replacement-fixture';

/** Execute the shipped native adapter. Files/Keychain/native AES are ports; AES-GCM uses real crypto. */
function fixture(nativeAvailable=true){
  const files=new Map<string,Uint8Array>(),directories=new Set<string>(),secrets=new Map<string,string>();
  let occupiedBytes=0;
  const nativeReset={resetAppleIntegrityInstallation:vi.fn<()=>Promise<unknown>>(async()=>null)};
  const uri=(...parts:unknown[])=>parts.map(p=>typeof p==='string'?p:(p as {uri:string}).uri).join('/');
  class Directory {
    uri:string;constructor(...parts:unknown[]){this.uri=uri(...parts);}
    get name(){return this.uri.split('/').at(-1)!;}
    get exists(){return directories.has(this.uri);}
    get size(){return occupiedBytes+[...files].filter(([path])=>path.startsWith(this.uri+'/')).reduce((total,[,bytes])=>total+bytes.byteLength,0);}
    list(){return [...[...files.keys()].filter(path=>path.startsWith(this.uri+'/')&&!path.slice(this.uri.length+1).includes('/')).map(path=>new File(path)),...[...directories].filter(path=>path.startsWith(this.uri+'/')&&!path.slice(this.uri.length+1).includes('/')).map(path=>new Directory(path))];}
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
    moveSync(destination:File){if(files.has(destination.uri))throw Error('destination exists');const value=files.get(this.uri);if(!value)throw Error('source missing');files.set(destination.uri,value);files.delete(this.uri);this.uri=destination.uri;}
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
    openNativeSignedClockJournal:(scope:enrollment.EnrollmentScope,assertCurrent:()=>void,ports:Omit<signedClock.SignedClockPorts,'assertCurrent'|'read'|'commit'>)=>Promise<ReturnType<typeof signedClock.createSignedClockJournal>&{retainOfflinePhoto(requestId:string,photo:unknown,bytes:Uint8Array):Promise<string>;readOfflinePhoto(requestId:string,photo:unknown):Promise<Uint8Array>}>;
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
    if(id==='./signed-clock-journal')return signedClock;
    if(id==='../../lib/mobile-offline-clock')return {OfflineClockClaimData};if(id==='./offline-clock-state')return offlineState;
    if(id==='./submission-journal')return journal;if(id==='./submission-storage')return storage;if(id==='./enrollment-journal')return enrollment;if(id==='./android-enrollment-journal')return androidEnrollment;throw new Error(id);
  }});
  return {native:output.exports,files,directories,secrets,secure,nativeReset,occupy:(bytes:number)=>{occupiedBytes=bytes;}};
}
const scope={namespace:'https://hr.example.com',actorId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employmentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const command=JSON.stringify({requestId,action:'in',lat:3,lng:101,accuracy:5,sampledAt:Date.now()});
describe('native encrypted submission adapter',()=>{
  it('retains maximum-size Apple proof beside a full retirement history and recovers it after restart',async()=>{
    const f=fixture(),e=appleReplacementFixture(true),open=()=>f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    const journal=await open();await journal.begin(e.employmentId,e.requestId);await journal.advance(e.employmentId);
    for(let n=0;n<14;n++){await journal.revoke(e.employmentId);await journal.replace(e.employmentId,enrollmentId(1000+n));await journal.advance(e.employmentId);}
    await journal.revoke(e.employmentId);await journal.replace(e.employmentId,enrollmentId(2000));
    vi.mocked(e.ports.complete).mockRejectedValueOnce(new Error('offline'));
    await expect(journal.advance(e.employmentId)).rejects.toThrow('offline');
    const bytes=[...f.files.values()][0];expect(bytes.byteLength).toBeGreaterThan(131072);expect(bytes.byteLength).toBeLessThan(262144+64);
    const reopened=await open();expect(await reopened.status()).toMatchObject({status:'pending',phase:'proof_ready',requestId:enrollmentId(2000)});
    expect(await reopened.advance(e.employmentId)).toMatchObject({status:'stored_key',revoked:false});expect(e.native.generateAppleKey).toHaveBeenCalledTimes(16);expect(e.native.attestAppleKey).toHaveBeenCalledTimes(16);
  });
  it('seals iPhone retirement history across reopening without retaining uploaded attestation bytes',async()=>{
    const f=fixture(),e=appleReplacementFixture();
    const first=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    await first.begin(e.employmentId,e.requestId);const original=await first.advance(e.employmentId);expect(original.status).toBe('stored_key');
    await first.revoke(e.employmentId);await first.replace(e.employmentId,enrollmentId(88));
    const reopened=await f.native.openNativeEnrollmentJournal(e.scope,e.ports.assertCurrent,e.ports);
    expect(await reopened.status()).toMatchObject({status:'pending',phase:'requested',requestId:enrollmentId(88)});
    expect(await reopened.advance(e.employmentId)).toMatchObject({status:'stored_key',revoked:false});
    const bytes=Buffer.from([...f.files.values()][0]),key=Buffer.from(f.secrets.get('aihr.submissions.key.v1')!,'base64');
    const scopeId=createHash('sha256').update(JSON.stringify(['enrollment-v1',e.scope.namespace,e.scope.apiOrigin,e.scope.actorId,e.scope.appInstallationId])).digest('hex');
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from('aihr-enrollment-v1:'+scopeId+':journal'));decipher.setAuthTag(bytes.subarray(-16));
    const saved=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString());
    expect(saved.version).toBe(3);expect(saved.retired).toHaveLength(1);expect(saved.retired[0].key.keyId).toBe(original.status==='stored_key'?original.keyId:'unexpected');
    expect(saved.retired[0].employmentId).toBe(e.employmentId);expect(saved.retired[0].key.revokedAt).not.toBeNull();expect(saved.pending).toBeNull();
    expect(saved.retired[0]).not.toHaveProperty('attestation');expect(saved.key).not.toHaveProperty('attestation');
  });
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
  it.each(['ios','android'] as const)('refuses a missing installation pointer with retained %s enrollment work',async(platform)=>{
    const f=fixture(),id=await f.native.nativeIntegrityInstallationId(()=>{});
    if(platform==='ios'){
      const e=enrollmentFixture(),opened=await f.native.openNativeEnrollmentJournal({...e.scope,appInstallationId:id},()=>{},e.ports);await opened.begin(e.employmentId,e.requestId);
    }else{
      const e=androidEnrollmentFixture(),opened=await f.native.openNativeAndroidEnrollmentJournal({...e.scope,appInstallationId:id},()=>{},e.ports);await opened.begin(e.employmentId,e.requestId);
    }
    const pointer=[...f.secrets.keys()].find(key=>key.startsWith('aihr.enrollment.installation.'))!;expect(pointer).toBeTruthy();
    const files=[...f.files].map(([name,value])=>[name,Buffer.from(value).toString('hex')]);f.secrets.delete(pointer);
    await expect(f.native.nativeIntegrityInstallationId(()=>{})).rejects.toThrow('Device enrollment storage unavailable');
    expect(f.secrets.has(pointer)).toBe(false);expect([...f.files].map(([name,value])=>[name,Buffer.from(value).toString('hex')])).toEqual(files);
  });
  it('allows a legacy submission-only install to initialize enrollment but refuses a corrupt empty pointer',async()=>{
    const f=fixture(),clock=await f.native.openNativeSubmissionJournal(scope,()=>{});await clock.stage('clock',command);
    const id=await f.native.nativeIntegrityInstallationId(()=>{});expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const pointer=[...f.secrets.keys()].find(key=>key.startsWith('aihr.enrollment.installation.'))!;f.secrets.set(pointer,'');
    await expect(f.native.nativeIntegrityInstallationId(()=>{})).rejects.toThrow('Device enrollment storage unavailable');expect(f.secrets.get(pointer)).toBe('');
    expect((await clock.pending())[0].command).toBe(command);
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


function signedPorts(){
 const source={provider:null,mock:null,simulated:null,accessory:null};
 const signedScope={namespace:'signed-test',apiOrigin:'https://hr.example.com',actorId:scope.actorId,appInstallationId:scope.actorId};
 const key={platform:'ios' as const,apiOrigin:signedScope.apiOrigin,actorId:scope.actorId,appInstallationId:signedScope.appInstallationId,installationId:scope.actorId,tenantId:scope.actorId,keyId:requestId,appId:'ABCDEFGHIJ.ai.hr',nativeReference:Buffer.alloc(32,7).toString('base64')};
 const receipt={id:requestId,direction:'in' as const,recordedAt:'2026-10-27T00:00:00.000Z',date:'2026-10-27',photoAvailable:false};
 let accepted=false;
 const ports:Omit<signedClock.SignedClockPorts,'assertCurrent'|'read'|'commit'>={
  base:async()=>({digest:'a'.repeat(64),command:JSON.parse(command),photo:null,source}),
  key:async()=>({key,capability:{version:1,platform:'ios',appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:'apple_app_attest'}}),
  capabilities:async()=>({outcome:'capabilities',protocol:2,platform:'ios',commandProtocol:1,features:['online_clock_assertion'],offline:false,cloudProjectNumber:null}),
  begin:vi.fn(async()=>{throw new Error('not requested');}),sign:vi.fn(async()=>{throw new Error('not requested');}),play:vi.fn(async()=>{throw new Error('not requested');}),complete:vi.fn(async()=>{throw new Error('not requested');}),
  receipt:async()=>({kind:'clock',requestId,receipt:accepted?receipt:null}),abandon:vi.fn(async()=>{throw new Error('not requested');}),resolveBase:vi.fn(async()=>{}),
 };
 return {scope:signedScope,ports,accept:()=>{accepted=true;}};
}
describe('encrypted installed-account signed clock lease',()=>{
 it('seals across restart, isolates account AAD and still resolves a receipt at the installation quota',async()=>{
  const f=fixture(),s=signedPorts(),open=()=>f.native.openNativeSignedClockJournal(s.scope,()=>{},s.ports);
  const j=await open();await j.start(scope.employmentId,requestId);
  const paths=[...f.files.keys()].filter(path=>path.includes('/signed-clock-'));expect(paths).toHaveLength(1);
  expect(Buffer.from(f.files.get(paths[0])!).toString()).not.toContain(requestId);
  expect(await (await open()).status(scope.employmentId)).toMatchObject({status:'pending',phase:'intent'});
  const other=await f.native.openNativeSignedClockJournal({...s.scope,actorId:scope.employmentId},()=>{},s.ports);
  expect(await other.status(scope.employmentId)).toEqual({status:'empty'});
  f.occupy(64*1024*1024);s.accept();expect(await (await open()).recover(scope.employmentId)).toMatchObject({status:'accepted'});
  expect(await (await open()).status(scope.employmentId)).toEqual({status:'empty'});expect(s.ports.begin).not.toHaveBeenCalled();
 });
 it('quarantines an orphan signed pointer and refuses a new installation identity beside its pending lease',async()=>{
  const f=fixture(),s=signedPorts(),appInstallationId=await f.native.nativeIntegrityInstallationId(()=>{});
  s.scope.appInstallationId=appInstallationId;
  s.ports.key=async()=>({key:{platform:'ios',apiOrigin:s.scope.apiOrigin,actorId:s.scope.actorId,appInstallationId,installationId:scope.actorId,tenantId:scope.actorId,keyId:requestId,appId:'ABCDEFGHIJ.ai.hr',nativeReference:Buffer.alloc(32,7).toString('base64')},
   capability:{version:1,platform:'ios',appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:'apple_app_attest'}});
  await (await f.native.openNativeSignedClockJournal(s.scope,()=>{},s.ports)).start(scope.employmentId,requestId);
  const pointer=[...f.secrets.keys()].find(key=>key.startsWith('aihr.signed-clock.'))!;expect(pointer).toBeTruthy();f.secrets.delete(pointer);
  await expect((await f.native.openNativeSignedClockJournal(s.scope,()=>{},s.ports)).status(scope.employmentId)).rejects.toThrow();
  const installation=[...f.secrets.keys()].find(key=>key.startsWith('aihr.enrollment.installation.'))!;f.secrets.delete(installation);
  await expect(f.native.nativeIntegrityInstallationId(()=>{})).rejects.toBeInstanceOf(enrollment.EnrollmentJournalUnavailable);
 });
});

function offlinePortsForStorage(s:ReturnType<typeof signedPorts>){
 const binding={scope:{apiOrigin:s.scope.apiOrigin,installationId:scope.actorId,tenantId:scope.actorId,companyId:scope.actorId,actorId:s.scope.actorId,employmentId:scope.employmentId,appInstallationId:s.scope.appInstallationId,deviceKeyId:requestId},
  target:{platform:'ios' as const,appId:'ABCDEFGHIJ.ai.hr',environment:'production' as const},request:{requestId,requestNonce:'A'.repeat(43),appInstallationId:s.scope.appInstallationId,keyId:requestId}};
 s.ports.offline={snapshot:()=>({status:'evidence',verification:'not_verified',evidence:{localOnly:true,runtimeId:scope.actorId,source:'ios_continuous',elapsedBeforeNs:'10',elapsedAfterNs:'11',wallTimeMs:1793055753390,bootId:null}}),
  request:vi.fn(async()=>{throw Error('not requested');}),verify:vi.fn(async()=>{throw Error('not requested');})};
 return binding;
}
it('seals offline request and raw local anchor in the existing account owner and restores them across restart',async()=>{
 const f=fixture(),s=signedPorts(),binding=offlinePortsForStorage(s),open=()=>f.native.openNativeSignedClockJournal(s.scope,()=>{},s.ports);
 await (await open()).reserveOffline(binding);
 expect(await (await open()).status(scope.employmentId)).toMatchObject({status:'offline_pending',requestId,phase:'context_requested'});
 const paths=[...f.files.keys()].filter(path=>path.includes('/signed-clock-'));expect(paths).toHaveLength(1);
 const ciphertext=Buffer.from(f.files.get(paths[0])!).toString();expect(ciphertext).not.toContain('requestStarted');expect(ciphertext).not.toContain(requestId);
 await expect((await open()).start(scope.employmentId,requestId)).rejects.toThrow('Review the saved signed clock attempt');expect(s.ports.offline!.request).not.toHaveBeenCalled();
});
it('does not treat new offline preparation as quota-exempt resolution merely because online pending is empty',async()=>{
 const f=fixture(),s=signedPorts(),binding=offlinePortsForStorage(s),j=await f.native.openNativeSignedClockJournal(s.scope,()=>{},s.ports);
 // The installation master was opened above. Model an existing, full submission directory.
 f.directories.add('document/aihr-submissions-v1');f.occupy(64*1024*1024);await expect(j.reserveOffline(binding)).rejects.toThrow();
 expect(s.ports.offline!.request).not.toHaveBeenCalled();expect(s.ports.sign).not.toHaveBeenCalled();
});

async function offlinePhotoFixture(){
 const f=fixture(),s=signedPorts(),binding=offlinePortsForStorage(s),pair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(pair.privateKey),issuedAt=1793055753390;
 const context:OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',issuer:{algorithm:'ed25519',keyId:identity.keyId},id:requestId,requestId,requestNonce:binding.request.requestNonce,
  scope:binding.scope,target:binding.target,issuedAt,expiresAt:issuedAt+3600000,policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},sites:[],
  attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},permits:[{id:scope.actorId,ordinal:1,nonce:'A'.repeat(43)},{id:scope.employmentId,ordinal:2,nonce:'B'.repeat(42)+'A'}]};
 const issuer={...identity,validFrom:issuedAt-1,validUntil:issuedAt+86400000,revoked:false};
 const raw=signOfflineClockContext(context,pair.privateKey),source={provider:null,mock:null,simulated:null,accessory:null},photoBytes=Uint8Array.from([1,2,3,4]);
 const baseScope={namespace:'offline-base',actorId:scope.actorId,employmentId:scope.employmentId},base=await f.native.openNativeSubmissionJournal(baseScope,()=>{});
 let controller:Awaited<ReturnType<typeof f.native.openNativeSignedClockJournal>>;
 s.ports.base=async(_employment,id)=>{const entry=(await base.pending()).find(value=>value.requestId===id);if(!entry)throw Error('base unavailable');return {digest:entry.digest,command:JSON.parse(entry.command),source,
  photo:entry.evidence?{sha256:entry.evidence.digest,byteLength:entry.evidence.size,mimeType:'image/jpeg'}:null};};
 s.ports.offline!.request=async()=>raw;s.ports.offline!.verify=async(text,expected)=>verifyOfflineClockContextSignature(text,[issuer],expected.scope);
 const release=vi.fn(async(reference:signedClock.SignedClockReference)=>{
  const entry=(await base.pending()).find(value=>value.requestId===reference.requestId);if(!entry)return;
  if(entry.digest!==reference.baseDigest)throw Error('changed base');await base.resolve('clock',reference.requestId);
 });
 s.ports.offline!.capture={capabilities:()=>({status:'evidence',verification:'not_verified',evidence:{version:1,platform:'ios',appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:'apple_app_attest'}}),
  digest:async canonical=>createHash('sha256').update(canonical).digest('hex'),
  retainPhoto:async(id,photo)=>controller.retainOfflinePhoto(id,photo,photoBytes),releaseBase:release};
 const open=async()=>{controller=await f.native.openNativeSignedClockJournal(s.scope,()=>{},s.ports);return controller;};
 await open();await controller!.reserveOffline(binding);await controller!.prepareOffline(requestId);
 const stage=async(id=requestId,withPhoto=true)=>{
  const file={uri:'cache/'+id+'.jpg',name:'evidence.jpg',mimeType:'image/jpeg',size:photoBytes.length};f.files.set(file.uri,photoBytes);
  await base.stage('clock',JSON.stringify({...JSON.parse(command),requestId:id}),withPhoto?file:undefined,source);
 };
 const input=(id=requestId)=>({requestId:id,expectedContextId:context.id,claimedAt:issuedAt,eventSnapshot:{localOnly:true,runtimeId:scope.actorId,source:'ios_continuous',elapsedBeforeNs:'30',elapsedAfterNs:'31',wallTimeMs:issuedAt,bootId:null}});
 const expectedPhoto={sha256:createHash('sha256').update(photoBytes).digest('hex'),byteLength:photoBytes.length,mimeType:'image/jpeg'};
 return {f,s,base,open,stage,input,expectedPhoto,photoBytes,release};
}
it('transfers photos into the sealed proof owner before freeing the base clock slot, then captures the next offline command',async()=>{
 const f=await offlinePhotoFixture();await f.stage();await (await f.open()).captureOffline(f.input());expect(await f.base.pending()).toEqual([]);
 const files=[...f.f.files.keys()].filter(path=>path.includes('/signed-clock-')&&path.endsWith('.sealed')&&!path.includes('/journal-'));expect(files).toHaveLength(1);
 expect(f.f.files.get(files[0])).not.toEqual(f.photoBytes);expect(await (await f.open()).readOfflinePhoto(requestId,f.expectedPhoto)).toEqual(f.photoBytes);
 const next='00000000-0000-4000-8000-000000000077';await f.stage(next);await (await f.open()).captureOffline(f.input(next));expect(await f.base.pending()).toEqual([]);
 expect(await (await f.open()).readOfflinePhoto(requestId,f.expectedPhoto)).toEqual(f.photoBytes);expect(await (await f.open()).readOfflinePhoto(next,f.expectedPhoto)).toEqual(f.photoBytes);
});
it('keeps both base and captured intent when the installation cannot admit another encrypted photo',async()=>{
 const f=await offlinePhotoFixture();await f.stage();f.f.occupy(64*1024*1024-65536);
 await expect((await f.open()).captureOffline(f.input())).rejects.toThrow('Pending submission storage is full');
 expect(await f.base.pending()).toHaveLength(1);expect(f.release).not.toHaveBeenCalled();expect(f.s.ports.sign).not.toHaveBeenCalled();
 f.f.occupy(0);await (await f.open()).captureOffline(f.input());expect(await f.base.pending()).toEqual([]);expect(await (await f.open()).readOfflinePhoto(requestId,f.expectedPhoto)).toEqual(f.photoBytes);
});
it('finishes phase-only capture recovery at the quota without treating another command as a resolution',async()=>{
 const f=await offlinePhotoFixture();await f.stage(requestId,false);f.release.mockImplementationOnce(async reference=>{await f.base.resolve('clock',reference.requestId);f.f.occupy(64*1024*1024);});
 expect(await (await f.open()).captureOffline(f.input())).toMatchObject({status:'captured'});
 const next='00000000-0000-4000-8000-000000000078';f.f.occupy(0);await f.stage(next,false);f.f.occupy(64*1024*1024);
 await expect((await f.open()).captureOffline(f.input(next))).rejects.toThrow();expect(await f.base.pending()).toHaveLength(1);
});
it('refuses changed photo bytes/metadata and cross-account reads without overwriting retained evidence',async()=>{
 const f=await offlinePhotoFixture();await f.stage();const j=await f.open();await j.captureOffline(f.input());
 await expect(j.retainOfflinePhoto(requestId,f.expectedPhoto,Uint8Array.from([9,9,9,9]))).rejects.toThrow();
 await expect(j.readOfflinePhoto(requestId,{...f.expectedPhoto,sha256:'c'.repeat(64)})).rejects.toThrow();
 const other=await f.f.native.openNativeSignedClockJournal({...f.s.scope,actorId:scope.employmentId},()=>{},f.s.ports);
 await expect(other.readOfflinePhoto(requestId,f.expectedPhoto)).rejects.toThrow();expect(await j.readOfflinePhoto(requestId,f.expectedPhoto)).toEqual(f.photoBytes);
});
it('refuses missing/tampered retained ciphertext instead of treating it as an absent or newly replaceable photo',async()=>{
 const f=await offlinePhotoFixture();await f.stage();await (await f.open()).captureOffline(f.input());
 const path=[...f.f.files.keys()].find(path=>path.endsWith(offlineState.offlineClockPhotoReference(requestId)))!,saved=f.f.files.get(path)!.slice();
 const changed=saved.slice();changed[changed.length-1]^=1;f.f.files.set(path,changed);
 await expect((await f.open()).readOfflinePhoto(requestId,f.expectedPhoto)).rejects.toThrow();await expect((await f.open()).retainOfflinePhoto(requestId,f.expectedPhoto,f.photoBytes)).rejects.toThrow();
 expect(f.f.files.get(path)).toEqual(changed);f.f.files.set(path,saved);expect(await (await f.open()).readOfflinePhoto(requestId,f.expectedPhoto)).toEqual(f.photoBytes);
});
