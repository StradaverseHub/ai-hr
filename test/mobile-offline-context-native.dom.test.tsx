/** Executes the shipped verifier with actual Noble Ed25519 and Node SHA-256 instead of Expo's OS port.
 * No native OS/device, registry provisioning or attendance-acceptance claim. */
import {createHash,generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import * as zod from 'zod';
import * as contextContract from '../lib/mobile-offline-context';
import * as claimContract from '../lib/mobile-offline-clock';
import {setupBytes} from '../lib/mobile-workplace-setup';
import {offlineContextIssuerIdentity,signOfflineClockContext,verifyOfflineClockContextSignature} from '../lib/mobile-api/offline-context-signature';
import type {OfflineClockContextBinding as ExpectedOfflineContext,OfflineClockContextVerificationResult as NativeOfflineContextResult} from '../lib/mobile-offline-context';
const nativeRequire=createRequire(resolve('mobile/package.json'));
const {ed25519}=await import(pathToFileURL(nativeRequire.resolve('@noble/curves/ed25519.js')).href);
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const realDigest=async(_algorithm:unknown,bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest()).buffer;
function nativeVerifier(hash=realDigest){
 const module={exports:{} as {verifyNativeOfflineClockContext:(raw:string,keys:contextContract.OfflineClockContextIssuer[],expected:ExpectedOfflineContext,check:()=>void)=>Promise<NativeOfflineContextResult>}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/offline-context.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
  {exports:module.exports,module,ArrayBuffer,Uint8Array,require:(name:string)=>{
   if(name==='@noble/curves/ed25519.js')return {ed25519};
   if(name==='expo-crypto')return {CryptoDigestAlgorithm:{SHA256:'SHA-256'},digest:hash};
   if(name==='zod')return zod;
   if(name==='../../lib/mobile-workplace-setup')return {setupBytes};
   if(name==='../../lib/mobile-offline-context')return contextContract;
   if(name==='../../lib/mobile-offline-clock')return claimContract;
   throw new Error('Unexpected dependency '+name);
  }});
 return module.exports.verifyNativeOfflineClockContext;
}
function fixture(platform:'ios'|'android'='ios'){
 const pair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(pair.privateKey),issuedAt=1793055753390;
 const context:contextContract.OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',issuer:{algorithm:'ed25519',keyId:identity.keyId},
  id:id(1),requestId:id(2),requestNonce:'A'.repeat(43),scope:{apiOrigin:'https://hr.example.com',installationId:id(3),tenantId:id(4),companyId:id(5),actorId:id(6),employmentId:id(7),appInstallationId:id(8),deviceKeyId:id(9)},
  target:platform==='ios'?{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production'}:{platform:'android',appId:'ai.hr',environment:null},issuedAt,expiresAt:issuedAt+3600000,
  policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:true,maximumAccuracyM:50,photoRequirement:'optional'},
  sites:[{id:id(10),name:'站点 · Pejabat 🏢',lat:3,lng:101,radiusM:100}],attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},
  permits:[{id:id(11),ordinal:1,nonce:'A'.repeat(43)}]};
 const issuer={...identity,validFrom:issuedAt-1,validUntil:issuedAt+86400000,revoked:false};
 const expected:ExpectedOfflineContext={scope:context.scope,target:context.target,request:{requestId:context.requestId,requestNonce:context.requestNonce,appInstallationId:context.scope.appInstallationId,keyId:context.scope.deviceKeyId}};
 return {pair,context,issuer,expected,raw:()=>signOfflineClockContext(context,pair.privateKey)};
}
describe('native offline context signature boundary',()=>{
 it.each(['ios','android'] as const)('verifies actual server bytes and Unicode for %s without granting attendance',async platform=>{
  const f=fixture(platform),raw=f.raw();
  expect(await nativeVerifier()(raw,[f.issuer],f.expected,()=>{})).toEqual(verifyOfflineClockContextSignature(raw,[f.issuer],f.context.scope));
 });
 it('binds the original request UUID and nonce even when another context has a valid server signature',async()=>{
  const f=fixture(),check=nativeVerifier();
  for(const request of [{...f.expected.request,requestId:id(99)},{...f.expected.request,requestNonce:'B'.repeat(42)+'A'}])
   expect(await check(f.raw(),[f.issuer],{...f.expected,request},()=>{})).toEqual({outcome:'invalid',reason:'request_mismatch'});
 });
 it.each(['installationId','tenantId','companyId','actorId','employmentId','appInstallationId','deviceKeyId'] as const)('refuses a different %s',async field=>{
  const f=fixture(),scope={...f.expected.scope,[field]:id(99)},request={...f.expected.request,appInstallationId:scope.appInstallationId,keyId:scope.deviceKeyId};
  expect(await nativeVerifier()(f.raw(),[f.issuer],{...f.expected,scope,request},()=>{})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('refuses wrong app, platform, environment and deployment',async()=>{
  const f=fixture();for(const target of [{...f.context.target,appId:'KLMNOPQRST.ai.hr'},{platform:'ios' as const,appId:'ABCDEFGHIJ.ai.hr',environment:'development' as const},{platform:'android' as const,appId:'ai.hr',environment:null}])
   expect(await nativeVerifier()(f.raw(),[f.issuer],{...f.expected,target},()=>{})).toEqual({outcome:'invalid',reason:'target_mismatch'});
  expect(await nativeVerifier()(f.raw(),[f.issuer],{...f.expected,scope:{...f.expected.scope,apiOrigin:'https://other.example.com'}},()=>{})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('refuses tampering and self-supplied issuer keys',async()=>{
  const f=fixture(),envelope=JSON.parse(f.raw());
  expect(await nativeVerifier()(JSON.stringify({...envelope,context:{...envelope.context,expiresAt:envelope.context.expiresAt+1}}),[f.issuer],f.expected,()=>{})).toEqual({outcome:'invalid',reason:'invalid_signature'});
  expect(await nativeVerifier()(JSON.stringify({...envelope,publicKey:f.issuer.publicKey}),[f.issuer],f.expected,()=>{})).toEqual({outcome:'invalid',reason:'malformed'});
 });
 it('refuses unknown, revoked and invalid-period issuers',async()=>{
  const f=fixture(),other=fixture();
  for(const issuer of [other.issuer,{...f.issuer,revoked:true},{...f.issuer,validFrom:f.context.issuedAt+1},{...f.issuer,validUntil:f.context.expiresAt-1}])
   expect(await nativeVerifier()(f.raw(),[issuer],f.expected,()=>{})).toEqual({outcome:'invalid',reason:'issuer_unavailable'});
 });
 it('keeps malformed trusted configuration and hashing failure unavailable',async()=>{
  const f=fixture();for(const issuers of [[],[f.issuer,f.issuer],[{...f.issuer,keyId:'c'.repeat(64)}]])
   await expect(nativeVerifier()(f.raw(),issuers,f.expected,()=>{})).rejects.toThrow('Offline context verification unavailable');
  await expect(nativeVerifier(async()=>{throw Error('private diagnostics');})(f.raw(),[f.issuer],f.expected,()=>{})).rejects.toThrow('Offline context verification unavailable');
  await expect(nativeVerifier(async()=>new ArrayBuffer(31))(f.raw(),[f.issuer],f.expected,()=>{})).rejects.toThrow('Offline context verification unavailable');
  await expect(nativeVerifier()(f.raw(),[f.issuer],{...f.expected,request:{...f.expected.request,keyId:id(99)}},()=>{})).rejects.toThrow('Offline context verification unavailable');
 });
 it.each([1,2])('stops when ownership changes during hash operation %s',async loseOn=>{
  const f=fixture();let owner=true,calls=0;
  const hash=async(algorithm:unknown,bytes:Uint8Array)=>{const result=await realDigest(algorithm,bytes);if(++calls===loseOn)owner=false;return result;};
  await expect(nativeVerifier(hash)(f.raw(),[f.issuer],f.expected,()=>{if(!owner)throw Error('Session changed');})).rejects.toThrow('Session changed');
  expect(calls).toBe(loseOn);
 });
 it('checks ownership before any cryptography and preserves ownership refusal when hashing fails',async()=>{
  const f=fixture(),hash=vi.fn(realDigest);
  await expect(nativeVerifier(hash)(f.raw(),[f.issuer],f.expected,()=>{throw Error('Session changed');})).rejects.toThrow('Session changed');expect(hash).not.toHaveBeenCalled();
  let owner=true;
  await expect(nativeVerifier(async()=>{owner=false;throw Error('hash failed');})(f.raw(),[f.issuer],f.expected,()=>{if(!owner)throw Error('Session changed');})).rejects.toThrow('Session changed');
 });
 it('bounds raw input, rejects malformed encodings and never uses reported wall time to approve expiry',async()=>{
  const f=fixture(),envelope=JSON.parse(f.raw());
  for(const raw of ['{',f.raw()+' '.repeat(65536),JSON.stringify({...envelope,signature:envelope.signature+'='})])
   expect(await nativeVerifier()(raw,[f.issuer],f.expected,()=>{})).toEqual({outcome:'invalid',reason:'malformed'});
  expect(await nativeVerifier()(f.raw(),[f.issuer],f.expected,()=>{})).toMatchObject({authorization:'not_granted'});
 });
});
