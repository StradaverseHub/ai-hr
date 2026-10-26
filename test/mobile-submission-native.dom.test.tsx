import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as journal from '../mobile/lib/submission-journal';
import * as storage from '../mobile/lib/submission-storage';

/** Execute the shipped native adapter. Files/Keychain/native AES are ports; AES-GCM uses real crypto. */
function fixture(){
  const files=new Map<string,Uint8Array>(),directories=new Set<string>(),secrets=new Map<string,string>();
  const uri=(...parts:unknown[])=>parts.map(p=>typeof p==='string'?p:(p as {uri:string}).uri).join('/');
  class Directory {
    uri:string;constructor(...parts:unknown[]){this.uri=uri(...parts);}
    get exists(){return directories.has(this.uri);}
    create(){directories.add(this.uri);directories.add('document/aihr-submissions-v1');}
    delete(){for(const key of directories)if(key.startsWith(this.uri))directories.delete(key);for(const key of files.keys())if(key.startsWith(this.uri+'/'))files.delete(key);}
  }
  class File {
    uri:string;constructor(...parts:unknown[]){this.uri=uri(...parts);}
    get exists(){return files.has(this.uri);}
    get size(){return files.get(this.uri)?.byteLength??0;}
    async bytes(){return files.get(this.uri)!.slice();}
    write(value:Uint8Array){files.set(this.uri,value.slice());}
    delete(){files.delete(this.uri);}
  }
  const secure={WHEN_UNLOCKED_THIS_DEVICE_ONLY:'device-unlocked',
    getItemAsync:vi.fn(async(key:string)=>secrets.get(key)??null),
    setItemAsync:vi.fn(async(key:string,value:string)=>{secrets.set(key,value);}),
    deleteItemAsync:vi.fn(async(key:string)=>{secrets.delete(key);})};
  const crypto={randomUUID,CryptoDigestAlgorithm:{SHA256:'sha256'},
    digestStringAsync:async(_:string,value:string)=>createHash('sha256').update(value).digest('hex'),
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
  }};
  const code=transpileModule(readFileSync('mobile/lib/submission-native.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,{exports:output.exports,module:output,Uint8Array,TextEncoder,TextDecoder,require:(id:string)=>{
    if(id==='expo-file-system')return {Directory,File,Paths:{document:'document',cache:'cache'}};
    if(id==='expo-secure-store')return secure;if(id==='expo-crypto')return crypto;
    if(id==='./submission-journal')return journal;if(id==='./submission-storage')return storage;throw new Error(id);
  }});
  return {native:output.exports,files,directories,secrets,secure};
}
const scope={namespace:'https://hr.example.com',actorId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employmentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const command=JSON.stringify({requestId,action:'in',lat:3,lng:101,accuracy:5,sampledAt:Date.now()});
describe('native encrypted submission adapter',()=>{
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
