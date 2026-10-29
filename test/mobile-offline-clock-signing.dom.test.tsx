/** Shipped signer/bridge; synthetic keys and SDK ports with real crypto. No vendor/device acceptance. */
import {createHash,generateKeyPairSync,sign,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import cbor from 'cbor';
import {describe,expect,it,vi} from 'vitest';
import * as contract from '../lib/mobile-offline-clock';
import * as keys from '../mobile/lib/clock-signing-key';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {checkAppAttestAssertion} from '../lib/mobile-api/app-attest-assertion';
import {SessionChangedError,UnavailableError} from '../mobile/lib/errors';
import type {OfflineClockProofPorts} from '../mobile/lib/offline-clock-state';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(platform:'ios'|'android'='ios'){
 let current=true,foreground=true,counter=0;
 const check=()=>{if(!current)throw new SessionChangedError();},pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const key:keys.ClockSigningKey={platform,apiOrigin:'https://hr.example.com',installationId:id(1),tenantId:id(2),actorId:id(4),appInstallationId:id(6),keyId:id(7),appId:platform==='ios'?'ABCDEFGHIJ.ai.hr':'ai.hr',nativeReference:platform==='ios'?Buffer.alloc(32,7).toString('base64'):'aihr_'+'a'.repeat(64)};
 const claim:contract.OfflineClockClaimData={version:1,purpose:'attendance.clock.offline.claim',scope:{apiOrigin:key.apiOrigin,installationId:id(1),tenantId:id(2),companyId:id(3),actorId:id(4),employmentId:id(5),appInstallationId:id(6),deviceKeyId:id(7)},context:{id:id(8),sha256:'a'.repeat(64)},permit:{id:id(9),ordinal:1,nonce:'A'.repeat(43)},chain:{sequence:1,previousSha256:null},
  command:{requestId:id(10),action:'in',lat:3,lng:101,accuracy:5,sampledAt:1793055753390,photo:null},time:{claimedAt:1793055753390,elapsed:{status:'elapsed',minimumNs:'10',maximumNs:'20',continuity:'same_process'}},evidence:{platform,appId:'ai.hr',appVersion:'版本 1',buildVersion:'4',provider:null,mock:false,simulated:null,accessory:null}};
 const native={capabilities:vi.fn(()=>({version:1,platform,appId:'ai.hr',appVersion:'2',buildVersion:'5',keyMechanism:platform==='ios'?'apple_app_attest':'android_keystore'})),
  appleOfflineProofInfo:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>({state:'absent'})),releaseAppleOfflineProof:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>null),
  assertAppleOfflineKey:vi.fn(async(_keyId:string,hash:string)=>{
   const auth=Buffer.alloc(37);createHash('sha256').update(key.appId).digest().copy(auth);auth.writeUInt32BE(++counter,33);
   const nonce=createHash('sha256').update(auth).update(Buffer.from(hash,'base64')).digest();return cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,pair.privateKey)}).toString('base64');
  }),
  assertAppleKey:vi.fn(async()=>Buffer.from('legacy').toString('base64')),
  signAndroidCommand:vi.fn(async(_alias:string,encoded:string)=>sign('sha256',Buffer.from(encoded,'base64'),pair.privateKey).toString('base64')),
  preparePlayIntegrity:vi.fn(async()=>null),requestPlayIntegrity:vi.fn(async()=>''),generateAppleKey:vi.fn(async()=>''),createAndroidKey:vi.fn(async()=>({})),
 };
 const digest=vi.fn(async(_algorithm:unknown,text:string,_options:unknown)=>createHash('sha256').update(text,'utf8').digest('base64'));
 const bridge=createIntegrityBridge(native as never,check,50);
 const module={exports:{} as {createOfflineClockSigner:(native:ReturnType<typeof createIntegrityBridge>,check:()=>void,visible:()=>boolean)=>Omit<OfflineClockProofPorts,'verifyPhoto'>}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/offline-clock-signing.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
  {exports:module.exports,module,TextEncoder,Uint8Array,require:(name:string)=>{
   if(name==='expo-crypto')return {CryptoDigestAlgorithm:{SHA256:'SHA-256'},CryptoEncoding:{BASE64:'base64'},digestStringAsync:digest};
   if(name==='../../lib/mobile-offline-clock')return contract;if(name==='./clock-signing-key')return keys;if(name==='./errors')return {UnavailableError};throw Error('Unexpected dependency '+name);
  }});
 return {key,claim,native,bridge,digest,pair,signer:()=>module.exports.createOfflineClockSigner(bridge,check,()=>foreground),obsolete:()=>{current=false;},lock:()=>{foreground=false;}};
}
describe('owned offline claim signing adapters',()=>{
 it('signs exact Android UTF-8 claim bytes with SHA256withECDSA, preserving captured versions after an upgrade',async()=>{
  const f=fixture('android'),result=await f.signer().sign(f.key,f.claim);if(result.status!=='evidence')throw Error('missing proof');
  const [alias,encoded]=f.native.signAndroidCommand.mock.calls[0],canonical=contract.offlineClockClaimClientData(f.claim);
  expect(alias).toBe(f.key.nativeReference);expect(Buffer.from(encoded,'base64').toString('utf8')).toBe(canonical);
  expect(verify('sha256',Buffer.from(canonical,'utf8'),f.pair.publicKey,Buffer.from(result.evidence,'base64'))).toBe(true);
  expect(verify('sha256',Buffer.from(contract.offlineClockClaimClientData({...f.claim,command:{...f.claim.command,lat:4}})),f.pair.publicKey,Buffer.from(result.evidence,'base64'))).toBe(false);
  expect(f.claim.evidence).toMatchObject({appVersion:'版本 1',buildVersion:'4'});expect(result.verification).toBe('not_verified');
  expect(f.digest).not.toHaveBeenCalled();expect(f.native.preparePlayIntegrity).not.toHaveBeenCalled();expect(f.native.requestPlayIntegrity).not.toHaveBeenCalled();
 });
 it('binds iPhone assertion hashing to exact offline bytes and verifies synthetic math with the actual server primitive',async()=>{
  const f=fixture(),result=await f.signer().sign(f.key,f.claim);if(result.status!=='evidence')throw Error('missing proof');const canonical=contract.offlineClockClaimClientData(f.claim);
  expect(f.native.assertAppleOfflineKey).toHaveBeenCalledWith(f.key.nativeReference,createHash('sha256').update(canonical).digest('base64'));
  expect(checkAppAttestAssertion({assertion:Buffer.from(result.evidence,'base64'),clientData:Buffer.from(canonical),publicKey:f.pair.publicKey,appId:f.key.appId,previousCounter:0})).toEqual({nextCounter:1});
  expect(()=>checkAppAttestAssertion({assertion:Buffer.from(result.evidence,'base64'),clientData:Buffer.from(contract.offlineClockClaimClientData({...f.claim,time:{...f.claim.time,claimedAt:f.claim.time.claimedAt+1}})),publicKey:f.pair.publicKey,appId:f.key.appId,previousCounter:0})).toThrow();
  expect(f.native.assertAppleKey).not.toHaveBeenCalled();expect(f.native.generateAppleKey).not.toHaveBeenCalled();
 });
 it('reads/releases the iPhone cache using the same immutable hash without generating another assertion',async()=>{
  const f=fixture();expect(await f.signer().inspect(f.key,f.claim)).toMatchObject({status:'evidence',evidence:{state:'absent'}});
  expect(await f.signer().release(f.key,f.claim)).toMatchObject({status:'evidence',evidence:null});
  const hash=createHash('sha256').update(contract.offlineClockClaimClientData(f.claim)).digest('base64');
  expect(f.native.appleOfflineProofInfo).toHaveBeenCalledWith(f.key.nativeReference,hash);expect(f.native.releaseAppleOfflineProof).toHaveBeenCalledWith(f.key.nativeReference,hash);expect(f.native.assertAppleOfflineKey).not.toHaveBeenCalled();
 });
 it('requires the exact app bundle, not merely a suffix of the enrolled App ID',async()=>{
  const f=fixture();f.native.capabilities.mockReturnValueOnce({...f.native.capabilities(),appId:'hr'});
  expect(await f.signer().sign(f.key,f.claim)).toEqual({status:'invalid',reason:'invalid_input'});
  expect(await f.signer().sign(f.key,{...f.claim,evidence:{...f.claim.evidence,appId:'hr'}})).toEqual({status:'invalid',reason:'invalid_input'});expect(f.native.assertAppleOfflineKey).not.toHaveBeenCalled();
 });
 it.each(['installationId','tenantId','actorId','appInstallationId','deviceKeyId'] as const)('refuses a different signing-key %s',async field=>{
  const f=fixture();expect(await f.signer().sign(f.key,{...f.claim,scope:{...f.claim.scope,[field]:id(99)}})).toEqual({status:'invalid',reason:'invalid_input'});expect(f.native.assertAppleOfflineKey).not.toHaveBeenCalled();
 });
 it('refuses another origin, platform, online purpose and missing recovery methods without legacy fallback',async()=>{
  const f=fixture();for(const claim of [{...f.claim,scope:{...f.claim.scope,apiOrigin:'https://other.example.com'}},{...f.claim,evidence:{...f.claim.evidence,platform:'android'}},{...f.claim,purpose:'attendance.clock.online'}])
   expect(await f.signer().sign(f.key,claim as never)).toEqual({status:'invalid',reason:'invalid_input'});
  Reflect.deleteProperty(f.native,'appleOfflineProofInfo');expect(await f.signer().sign(f.key,f.claim)).toEqual({status:'unsupported',reason:'method_missing'});expect(f.native.assertAppleKey).not.toHaveBeenCalled();
 });
 it('permits completed-cache recovery/cleanup when new iPhone generation is unsupported',async()=>{
  const f=fixture();f.native.capabilities.mockReturnValue({...f.native.capabilities(),keyMechanism:'unsupported'});f.native.appleOfflineProofInfo.mockResolvedValueOnce({state:'completed',assertion:Buffer.from('retained').toString('base64')});
  expect(await f.signer().inspect(f.key,f.claim)).toMatchObject({status:'evidence',evidence:{state:'completed'}});
  expect(await f.signer().release(f.key,f.claim)).toMatchObject({status:'evidence',evidence:null});expect(await f.signer().sign(f.key,f.claim)).toEqual({status:'unsupported',reason:'unsupported'});expect(f.native.assertAppleOfflineKey).not.toHaveBeenCalled();
 });
 it('uses no iPhone cache operation or vendor network operation for Android inspect/cleanup',async()=>{
  const f=fixture('android');expect(await f.signer().inspect(f.key,f.claim)).toMatchObject({status:'evidence',evidence:{state:'absent'}});expect(await f.signer().release(f.key,f.claim)).toMatchObject({status:'evidence',evidence:null});
  expect(f.native.appleOfflineProofInfo).not.toHaveBeenCalled();expect(f.native.releaseAppleOfflineProof).not.toHaveBeenCalled();expect(f.native.signAndroidCommand).not.toHaveBeenCalled();expect(f.native.preparePlayIntegrity).not.toHaveBeenCalled();
 });
 it('refuses privacy lock/owner loss before native calls, including loss while hashing',async()=>{
  const f=fixture();f.lock();await expect(f.signer().sign(f.key,f.claim)).rejects.toBeInstanceOf(UnavailableError);expect(f.native.assertAppleOfflineKey).not.toHaveBeenCalled();
  const g=fixture();g.digest.mockImplementationOnce(async(_algorithm,text)=>{g.obsolete();return createHash('sha256').update(text).digest('base64');});
  await expect(g.signer().sign(g.key,g.claim)).rejects.toBeInstanceOf(SessionChangedError);expect(g.native.assertAppleOfflineKey).not.toHaveBeenCalled();
 });
 it('does not publish a native Android reply after its owner changes and rejects oversized signatures',async()=>{
  const f=fixture('android');f.native.signAndroidCommand.mockImplementationOnce(async()=>{f.obsolete();return Buffer.from('proof').toString('base64');});
  await expect(f.signer().sign(f.key,f.claim)).rejects.toBeInstanceOf(SessionChangedError);
  const g=fixture('android');g.native.signAndroidCommand.mockResolvedValueOnce(Buffer.alloc(73).toString('base64'));expect(await g.signer().sign(g.key,g.claim)).toEqual({status:'invalid',reason:'malformed'});
 });
});
