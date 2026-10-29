/** Executes the shipped phone context check (mobile/lib/offline-context.ts) with Node SHA-256 instead of Expo's OS port.
 * Keyless (owner decision D16): the server signs no context, so the check needs no Noble, no issuer registry and no key;
 * it proves shape and binding only, and the digest it returns is what the server's own record must match.
 * No native OS/device or attendance-acceptance claim. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import * as contextContract from '../lib/mobile-offline-context';
import type {OfflineClockContextBinding as ExpectedOfflineContext,OfflineClockContextVerificationResult as NativeOfflineContextResult} from '../lib/mobile-offline-context';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const realDigest=async(_algorithm:unknown,bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest()).buffer;
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const required:string[]=[];
function nativeCheck(hash=realDigest){
 const module={exports:{} as {verifyNativeOfflineClockContext:(raw:string,expected:ExpectedOfflineContext,check:()=>void)=>Promise<NativeOfflineContextResult>}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/offline-context.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
  {exports:module.exports,module,ArrayBuffer,Uint8Array,require:(name:string)=>{
   required.push(name);
   if(name==='expo-crypto')return {CryptoDigestAlgorithm:{SHA256:'SHA-256'},digest:hash};
   if(name==='../../lib/mobile-offline-context')return contextContract;
   throw new Error('Unexpected dependency '+name);
  }});
 return module.exports.verifyNativeOfflineClockContext;
}
function fixture(platform:'ios'|'android'='ios'){
 const issuedAt=1793055753390;
 const context:contextContract.OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',
  id:id(1),requestId:id(2),requestNonce:'A'.repeat(43),scope:{apiOrigin:'https://hr.example.com',installationId:id(3),tenantId:id(4),companyId:id(5),actorId:id(6),employmentId:id(7),appInstallationId:id(8),deviceKeyId:id(9)},
  target:platform==='ios'?{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production'}:{platform:'android',appId:'ai.hr',environment:null},issuedAt,expiresAt:issuedAt+3600000,
  policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:true,maximumAccuracyM:50,photoRequirement:'optional'},
  sites:[{id:id(10),name:'站点 · Pejabat 🏢',lat:3,lng:101,radiusM:100}],attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},
  permits:[{id:id(11),ordinal:1,nonce:'A'.repeat(43)}]};
 const expected:ExpectedOfflineContext={scope:context.scope,target:context.target,request:{requestId:context.requestId,requestNonce:context.requestNonce,appInstallationId:context.scope.appInstallationId,keyId:context.scope.deviceKeyId}};
 return {context,expected,raw:()=>contextContract.offlineClockContextJson(context)};
}
describe('native offline context check (keyless, owner decision D16)',()=>{
 it.each(['ios','android'] as const)('checks actual server bytes and Unicode for %s and returns the digest a claim must name, without granting attendance',async platform=>{
  const f=fixture(platform),raw=f.raw();required.length=0;
  expect(await nativeCheck()(raw,f.expected,()=>{})).toEqual({outcome:'context_valid',context:f.context,digest:sha(contextContract.offlineClockContextClientData(f.context)),authorization:'not_granted'});
  // The same canonical bytes the server binds; no Ed25519 library, registry or key is loaded on the phone.
  expect(contextContract.bindOfflineClockContext(raw,f.expected)).toMatchObject({outcome:'bound',canonical:contextContract.offlineClockContextClientData(f.context)});
  expect([...new Set(required)].sort()).toEqual(['../../lib/mobile-offline-context','expo-crypto']);
 });
 it('binds the original request UUID and nonce',async()=>{
  const f=fixture(),check=nativeCheck();
  for(const request of [{...f.expected.request,requestId:id(99)},{...f.expected.request,requestNonce:'B'.repeat(42)+'A'}])
   expect(await check(f.raw(),{...f.expected,request},()=>{})).toEqual({outcome:'invalid',reason:'request_mismatch'});
 });
 it.each(['installationId','tenantId','companyId','actorId','employmentId','appInstallationId','deviceKeyId'] as const)('refuses a different %s',async field=>{
  const f=fixture(),scope={...f.expected.scope,[field]:id(99)},request={...f.expected.request,appInstallationId:scope.appInstallationId,keyId:scope.deviceKeyId};
  expect(await nativeCheck()(f.raw(),{...f.expected,scope,request},()=>{})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('refuses wrong app, platform, environment and deployment origin',async()=>{
  const f=fixture();for(const target of [{...f.context.target,appId:'KLMNOPQRST.ai.hr'},{platform:'ios' as const,appId:'ABCDEFGHIJ.ai.hr',environment:'development' as const},{platform:'android' as const,appId:'ai.hr',environment:null}])
   expect(await nativeCheck()(f.raw(),{...f.expected,target},()=>{})).toEqual({outcome:'invalid',reason:'target_mismatch'});
  expect(await nativeCheck()(f.raw(),{...f.expected,scope:{...f.expected.scope,apiOrigin:'https://other.example.com'}},()=>{})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('carries no signature: an altered context yields another digest (the server record refuses it), and signed or issuer shapes are malformed',async()=>{
  const f=fixture(),original=await nativeCheck()(f.raw(),f.expected,()=>{});if(original.outcome!=='context_valid')throw new Error('Not valid');
  for(const change of [{expiresAt:f.context.expiresAt+1},{policy:{...f.context.policy,photoRequirement:'required' as const}},{sites:[{...f.context.sites[0],radiusM:100000}]},{permits:[{...f.context.permits[0],nonce:'C'.repeat(42)+'A'}]}]){
   const altered=await nativeCheck()(contextContract.offlineClockContextJson({...f.context,...change}),f.expected,()=>{});
   expect(altered).toMatchObject({outcome:'context_valid'});if(altered.outcome==='context_valid')expect(altered.digest).not.toBe(original.digest);
  }
  const context=JSON.parse(f.raw());
  for(const raw of [JSON.stringify({context,signature:'A'.repeat(86)}),JSON.stringify({...context,issuer:{algorithm:'ed25519',keyId:'c'.repeat(64)}}),JSON.stringify({...context,publicKey:'A'.repeat(43)})])
   expect(await nativeCheck()(raw,f.expected,()=>{})).toEqual({outcome:'invalid',reason:'malformed'});
 });
 it('keeps a malformed trusted binding and hashing failure unavailable',async()=>{
  const f=fixture();
  await expect(nativeCheck(async()=>{throw Error('private diagnostics');})(f.raw(),f.expected,()=>{})).rejects.toThrow('Offline context verification unavailable');
  await expect(nativeCheck(async()=>new ArrayBuffer(31))(f.raw(),f.expected,()=>{})).rejects.toThrow('Offline context verification unavailable');
  await expect(nativeCheck()(f.raw(),{...f.expected,request:{...f.expected.request,keyId:id(99)}},()=>{})).rejects.toThrow('Offline context verification unavailable');
 });
 it('stops when ownership changes during the hash operation',async()=>{
  const f=fixture();let owner=true,calls=0;
  const hash=async(algorithm:unknown,bytes:Uint8Array)=>{const result=await realDigest(algorithm,bytes);calls++;owner=false;return result;};
  await expect(nativeCheck(hash)(f.raw(),f.expected,()=>{if(!owner)throw Error('Session changed');})).rejects.toThrow('Session changed');
  expect(calls).toBe(1);
 });
 it('checks ownership before any hashing and preserves ownership refusal when hashing fails',async()=>{
  const f=fixture(),hash=vi.fn(realDigest);
  await expect(nativeCheck(hash)(f.raw(),f.expected,()=>{throw Error('Session changed');})).rejects.toThrow('Session changed');expect(hash).not.toHaveBeenCalled();
  let owner=true;
  await expect(nativeCheck(async()=>{owner=false;throw Error('hash failed');})(f.raw(),f.expected,()=>{if(!owner)throw Error('Session changed');})).rejects.toThrow('Session changed');
 });
 it('bounds raw input, accepts only the canonical text and never uses reported wall time to approve expiry',async()=>{
  const f=fixture(),context=JSON.parse(f.raw());
  for(const raw of ['{',f.raw()+' '.repeat(65536),f.raw()+' ',JSON.stringify(context,null,1),JSON.stringify(Object.fromEntries(Object.entries(context).reverse()))])
   expect(await nativeCheck()(raw,f.expected,()=>{})).toEqual({outcome:'invalid',reason:'malformed'});
  expect(await nativeCheck()(f.raw(),f.expected,()=>{})).toMatchObject({authorization:'not_granted'});
 });
});
