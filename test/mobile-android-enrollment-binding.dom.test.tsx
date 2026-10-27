/** Canonical-byte and port tests, not Android key ownership/hardware acceptance. */
import {createHash,generateKeyPairSync,sign,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import * as canonical from '../lib/mobile-android-enrollment';
import {keyEnrollmentClientData,nativeKeyBindingData} from '../lib/mobile-key-enrollment';
import {SessionChangedError} from '../mobile/lib/errors';
const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const target=()=>({platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee','strongbox'],
 provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null});
const context=()=>({version:1,purpose:'device.key.enrollment',apiOrigin:'https://hr.example.com',installationId:id(1),tenantId:id(2),actorId:id(3),employmentId:id(4),appInstallationId:id(5),requestId:id(6),challengeId:id(7),nonce:'A'.repeat(43),issuedAt:1800000000000,expiresAt:1800000600000,target:target()});
describe('Android scoped enrollment encoding',()=>{
 it('matches an independent positional vector and canonicalizes unordered policy sets/UUIDs',()=>{
  const p=context(),t=p.target;
  const expected=JSON.stringify(['aihr.mobile.integrity',1,'device.key.enrollment',[p.apiOrigin,id(1),id(2),id(3),id(4),id(5)],[id(6),id(7),p.nonce,p.issuedAt,p.expiresAt],['android',t.packageName,t.certificateDigests,t.versionCodes,['strongbox','tee'],'allow_legacy',[null,null,null,null]]]);
  expect(canonical.androidEnrollmentClientData(p)).toBe(expected);
  expect(canonical.androidEnrollmentClientData({...p,actorId:p.actorId.toUpperCase(),target:{...t,securityLevels:['strongbox','tee'],versionCodes:['4','4']}})).toBe(expected);
 });
 it('invalidates signatures when any actor/scope/challenge/app/signer/build/assurance requirement changes',()=>{
  const p=context(),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),signature=sign('sha256',Buffer.from(canonical.androidEnrollmentClientData(p)),pair.privateKey);
  const changed=[...['installationId','tenantId','actorId','employmentId','appInstallationId','requestId','challengeId'].map(key=>({...p,[key]:id(9)})),
   {...p,apiOrigin:'https://other.example.com'},{...p,nonce:'B'+'A'.repeat(42)},{...p,expiresAt:p.expiresAt-1},{...p,issuedAt:p.issuedAt+1},
   ...[{packageName:'other.app'},{certificateDigests:[Buffer.alloc(32,2).toString('base64')]},{versionCodes:['5']},{securityLevels:['strongbox']},{provisioningMetadata:'require_entity_and_lost_device'},
    {minimumOsVersion:160000},{minimumOsPatchLevel:202601},{minimumVendorPatchLevel:20260101},{minimumBootPatchLevel:20260101}].map(change=>({...p,target:{...p.target,...change}}))];
  for(const value of changed)expect(verify('sha256',Buffer.from(canonical.androidEnrollmentClientData(value)),pair.publicKey,signature)).toBe(false);
 });
 it('refuses Apple interpretation, extra authority, malformed policy or invalid time windows',()=>{
  const p=context();expect(()=>keyEnrollmentClientData(p)).toThrow();
  for(const change of [{version:2},{purpose:'attendance.clock.online'},{verified:true},{expiresAt:p.issuedAt},{expiresAt:p.expiresAt+1},{apiOrigin:'http://hr.example.com'},
   {target:{...p.target,securityLevels:['software']}},{target:{...p.target,minimumOsPatchLevel:202613}}])expect(()=>canonical.androidEnrollmentClientData({...p,...change})).toThrow();
 });
 it('hashes the same UTF8 bytes through Expo and rechecks ownership on successful and failed replies',async()=>{
  const digest=vi.fn(async(_algorithm:unknown,message:string)=>createHash('sha256').update(message,'utf8').digest('base64'));
  const output={exports:{} as {androidEnrollmentClientDataHash:(input:unknown,check:()=>void)=>Promise<string>}};
  runInNewContext(transpileModule(readFileSync('mobile/lib/android-enrollment-integrity.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
   {module:output,exports:output.exports,require:(name:string)=>{
    if(name==='expo-crypto')return {CryptoDigestAlgorithm:{SHA256:'SHA-256'},CryptoEncoding:{BASE64:'base64'},digestStringAsync:digest};
    if(name==='../../lib/mobile-android-enrollment')return canonical;
    if(name==='../../lib/mobile-key-enrollment')return {nativeKeyBindingData};throw new Error(name);
   }});
  const hash=output.exports.androidEnrollmentClientDataHash,p=context();expect(await hash(p,()=>{})).toBe(createHash('sha256').update(canonical.androidEnrollmentClientData(p)).digest('base64'));
  for(const fail of [false,true]){let current=true;digest.mockImplementationOnce(async()=>{current=false;if(fail)throw new Error('old crypto failure');return 'old hash';});
   await expect(hash(p,()=>{if(!current)throw new SessionChangedError();})).rejects.toBeInstanceOf(SessionChangedError);
  }
 });
});
