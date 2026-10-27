/** Actual adapter/bridge/hash code with synthetic SDK/crypto ports, not hardware acceptance. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import * as canonical from '../lib/mobile-android-enrollment';
import {nativeKeyBindingData} from '../lib/mobile-key-enrollment';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {SessionChangedError,UnavailableError} from '../mobile/lib/errors';
const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
function compile(path:string,ports:Record<string,unknown>){
 const output={exports:{} as Record<string,any>};
 runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,{module:output,exports:output.exports,structuredClone,require:(name:string)=>{if(name in ports)return ports[name];throw new Error(name);}});return output.exports;
}
function fixture(strongbox=false){
 let current=true,foreground=true;const order:string[]=[],assertCurrent=()=>{if(!current)throw new SessionChangedError();};
 const context={version:1,purpose:'device.key.enrollment',apiOrigin:'https://hr.example.com',installationId:id(1),tenantId:id(2),actorId:id(3),employmentId:id(4),appInstallationId:id(5),requestId:id(6),challengeId:id(7),nonce:'A'.repeat(43),issuedAt:1800000000000,expiresAt:1800000600000,target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:strongbox?['strongbox']:['tee','strongbox'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
 const prepared={protocol:2,state:'active',context,clientDataHash:createHash('sha256').update(canonical.androidEnrollmentClientData(context)).digest('base64'),alias:'aihr_'+createHash('sha256').update(canonical.androidEnrollmentAliasData(context)).digest('hex')};
 const evidence={publicKeySpki:Buffer.alloc(91,1).toString('base64'),certificateChain:[Buffer.from('synthetic leaf').toString('base64'),Buffer.from('synthetic root').toString('base64')],reportedSecurityLevel:'unknown'};
 const native={capabilities:vi.fn(()=>({version:1,platform:'android',keyMechanism:'android_keystore',appId:context.target.packageName,appVersion:'1.0',buildVersion:'4'})),
  createAndroidKey:vi.fn(async()=>{order.push('sdk-create');return evidence;}),androidKeyInfo:vi.fn(async()=>{order.push('sdk-read');return evidence;})};
 const digest=vi.fn(async(_algorithm:unknown,value:string,options:{encoding:'hex'|'base64'})=>createHash('sha256').update(value).digest(options.encoding));
 const hashes=compile('mobile/lib/android-enrollment-integrity.ts',{'../../lib/mobile-android-enrollment':canonical,'../../lib/mobile-key-enrollment':{nativeKeyBindingData},'expo-crypto':{CryptoDigestAlgorithm:{SHA256:'SHA-256'},CryptoEncoding:{HEX:'hex',BASE64:'base64'},digestStringAsync:digest}});
 const adapter=compile('mobile/lib/android-key-enrollment.ts',{'zod':{z},'../../lib/mobile-android-enrollment':canonical,'./android-enrollment-integrity':hashes,'./errors':{UnavailableError}});
 const bridge=createIntegrityBridge(native as never,assertCurrent,30),persist=vi.fn(async()=>{order.push('durable-intent');});
 return {prepared,evidence,native,persist,order,digest,hashes,adapter:adapter.createAndroidKeyEnrollment(bridge,assertCurrent,()=>foreground) as ReturnType<typeof import('../mobile/lib/android-key-enrollment').createAndroidKeyEnrollment>,changeOwner:()=>{current=false;},background:()=>{foreground=false;}};
}
afterEach(()=>vi.useRealTimers());
describe('Android native key enrollment adapter',()=>{
 it('reproduces the server public-key receipt binding without trusting local hardware hints',async()=>{
  const f=fixture(),spki=f.evidence.publicKeySpki,challengeId=f.prepared.context.challengeId;
  const reference=createHash('sha256').update(JSON.stringify(['aihr.android.native-key',1,spki])).digest('base64');
  const expected=createHash('sha256').update(JSON.stringify(['aihr.native-key-binding',1,challengeId,reference])).digest('hex');
  expect(await f.hashes.androidEnrollmentNativeKeyBinding(challengeId,spki,()=>{})).toBe(expected);
  expect(await f.hashes.androidEnrollmentNativeKeyBinding(id(8),spki,()=>{})).not.toBe(expected);
  expect(await f.hashes.androidEnrollmentNativeKeyBinding(challengeId,Buffer.alloc(91,2).toString('base64'),()=>{})).not.toBe(expected);
  for(const malformed of [spki+'\n','AB==',''])await expect(f.hashes.androidEnrollmentNativeKeyBinding(challengeId,malformed,()=>{})).rejects.toThrow();
 });
 it('drops a public-key reference hash after its owner becomes obsolete',async()=>{
  const f=fixture();let current=true;
  f.digest.mockImplementationOnce(async()=>{current=false;return Buffer.alloc(32).toString('base64');});
  await expect(f.hashes.androidEnrollmentNativeKeyBinding(f.prepared.context.challengeId,f.evidence.publicKeySpki,()=>{if(!current)throw new SessionChangedError();})).rejects.toBeInstanceOf(SessionChangedError);expect(f.digest).toHaveBeenCalledOnce();
 });
 it('persists intent before generation and passes the exact scoped alias/challenge/StrongBox requirement',async()=>{
  const f=fixture(true),result=await f.adapter.create(f.prepared,f.persist);expect(result).toEqual({status:'evidence',evidence:f.evidence,verification:'not_verified'});
  expect(f.order).toEqual(['durable-intent','sdk-create']);expect(f.native.createAndroidKey).toHaveBeenCalledExactlyOnceWith(f.prepared.alias,f.prepared.clientDataHash,true);expect(f.native.androidKeyInfo).not.toHaveBeenCalled();
 });
 it('reads an existing alias without generation, commit, replacement or hardware trust inference',async()=>{
  const f=fixture(),result=await f.adapter.read(f.prepared);expect(result).toMatchObject({status:'evidence',verification:'not_verified'});expect(f.order).toEqual(['sdk-read']);expect(f.native.createAndroidKey).not.toHaveBeenCalled();expect(f.persist).not.toHaveBeenCalled();
 });
 it('refuses altered scope/digest/alias or native app/build before a durable intent or SDK operation',async()=>{
  for(const change of [{clientDataHash:Buffer.alloc(32,2).toString('base64')},{alias:'aihr_'+'b'.repeat(64)},{context:{...fixture().prepared.context,actorId:id(9)}},{state:'expired'},{protocol:1}]){
   const f=fixture();expect(await f.adapter.create({...f.prepared,...change},f.persist)).toMatchObject({status:'invalid'});expect(f.persist).not.toHaveBeenCalled();expect(f.native.createAndroidKey).not.toHaveBeenCalled();
  }
  const f=fixture();f.native.capabilities.mockReturnValueOnce({...f.native.capabilities(),buildVersion:'5'});expect(await f.adapter.read(f.prepared)).toMatchObject({status:'invalid'});expect(f.native.androidKeyInfo).not.toHaveBeenCalled();
 });
 it('cannot generate after a failed durable commit or owner/foreground change during commit',async()=>{
  const f=fixture();f.persist.mockRejectedValueOnce(new Error('storage unavailable'));await expect(f.adapter.create(f.prepared,f.persist)).rejects.toThrow('storage unavailable');expect(f.native.createAndroidKey).not.toHaveBeenCalled();
  for(const change of ['owner','foreground']){const g=fixture();g.persist.mockImplementationOnce(async()=>{if(change==='owner')g.changeOwner();else g.background();});await expect(g.adapter.create(g.prepared,g.persist)).rejects.toThrow();expect(g.native.createAndroidKey).not.toHaveBeenCalled();}
 });
 it('never retries creation, downgrades StrongBox, or automatically reads after an existing/uncertain key result',async()=>{
  const f=fixture(true);f.native.createAndroidKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_KEY_EXISTS'});expect(await f.adapter.create(f.prepared,f.persist)).toMatchObject({status:'invalid',reason:'key_exists'});expect(f.native.createAndroidKey).toHaveBeenCalledOnce();expect(f.native.androidKeyInfo).not.toHaveBeenCalled();
  vi.useFakeTimers();const g=fixture();g.native.createAndroidKey.mockReturnValueOnce(new Promise(()=>{}));const pending=g.adapter.create(g.prepared,g.persist);await vi.advanceTimersByTimeAsync(31);expect(await pending).toMatchObject({status:'unavailable',reason:'timeout'});expect(g.native.createAndroidKey).toHaveBeenCalledOnce();expect(g.native.androidKeyInfo).not.toHaveBeenCalled();
 });
 it('drops obsolete SDK replies and refuses proof artifacts outside the server protocol bounds',async()=>{
  const f=fixture();f.native.androidKeyInfo.mockImplementationOnce(async()=>{f.changeOwner();return f.evidence;});await expect(f.adapter.read(f.prepared)).rejects.toBeInstanceOf(SessionChangedError);
  const g=fixture();g.evidence.certificateChain=[Buffer.alloc(16384).toString('base64'),Buffer.alloc(16384).toString('base64')];expect(await g.adapter.read(g.prepared)).toMatchObject({status:'unsupported'});expect(g.native.createAndroidKey).not.toHaveBeenCalled();
 });
});
