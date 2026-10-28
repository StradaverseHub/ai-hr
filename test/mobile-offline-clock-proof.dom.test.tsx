/** Real P256/CBOR math with synthetic registered keys; no vendor/device or attendance acceptance. */
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import cbor from 'cbor';
import {describe,expect,it} from 'vitest';
import {OfflineClockClaimData,offlineClockClaimClientData} from '../lib/mobile-offline-clock';
import {OfflineClockContextData,offlineClockContextClientData} from '../lib/mobile-offline-context';
import {verifyOfflineClockProof,OfflineClockProofUnavailable,type OfflineClockRegisteredKey} from '../lib/mobile-api/offline-clock-proof';
import {checkAndroidOfflineClockSignature} from '../lib/mobile-api/android-clock-signature';
import {onlineClockClientData} from '../lib/mobile-clock-integrity';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest();
function fixture(platform:'ios'|'android'='ios'){
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),issuedAt=1793055753390;
 const context:OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',id:id(1),requestId:id(2),requestNonce:'A'.repeat(43),
 scope:{apiOrigin:'https://hr.example.com',installationId:id(3),tenantId:id(4),companyId:id(5),actorId:id(6),employmentId:id(7),appInstallationId:id(8),deviceKeyId:id(9)},
 target:platform==='ios'?{platform,appId:'ABCDEFGHIJ.ai.hr',environment:'production'}:{platform,appId:'ai.hr',environment:null},issuedAt,expiresAt:issuedAt+3600000,
 policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},sites:[],
 attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},permits:[{id:id(12),ordinal:1,nonce:'A'.repeat(43)},{id:id(13),ordinal:2,nonce:'B'.repeat(42)+'A'}]};
 const key:OfflineClockRegisteredKey={id:id(9),tenantId:id(4),actorId:id(6),installationId:id(3),appInstallationId:id(8),...context.target,publicKey:pair.publicKey,assertionCounter:platform==='ios'?3:0};
 const claim:OfflineClockClaimData={version:1,purpose:'attendance.clock.offline.claim',scope:context.scope,context:{id:context.id,sha256:hash(offlineClockContextClientData(context)).toString('hex')},permit:context.permits[0],chain:{sequence:1,previousSha256:null},
 command:{requestId:id(20),action:'out',lat:3,lng:101,accuracy:5,sampledAt:issuedAt+1000,photo:{sha256:'c'.repeat(64),byteLength:100,mimeType:'image/jpeg'}},
 time:{claimedAt:issuedAt+2000,elapsed:{status:'elapsed',minimumNs:'1000000000',maximumNs:'2000000000',continuity:'same_process'}},
 evidence:{platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 const cursor={nextSequence:1,previousSha256:null};
 function signed(p=claim,counter=4){
  const bytes=Buffer.from(offlineClockClaimClientData(p));
  if(platform==='android')return {claim:p,proof:{platform,signature:sign('sha256',bytes,pair.privateKey).toString('base64')}};
  const auth=Buffer.alloc(37);hash(key.appId).copy(auth);auth.writeUInt32BE(counter,33);
  const nonce=hash(Buffer.concat([auth,hash(bytes)]));
  return {claim:p,proof:{platform,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,pair.privateKey)}).toString('base64')}};
 }
 return {pair,context,key,claim,cursor,signed,check:(input:unknown)=>verifyOfflineClockProof(input,context,key,cursor)};
}
describe('original offline proofs against issued context and locked stream snapshots',()=>{
 it.each(['ios','android'] as const)('checks %s bytes and advances only a proposed cursor, preserving out-first commands',platform=>{
  const f=fixture(platform),result=f.check(f.signed()),digest=hash(offlineClockClaimClientData(f.claim)).toString('hex');
  expect(result).toEqual({outcome:'proof_valid',authorization:'not_granted',claim:f.claim,digest,nextCounter:platform==='ios'?4:null,cursor:{nextSequence:2,previousSha256:digest}});
  expect(f.cursor).toEqual({nextSequence:1,previousSha256:null});expect(f.key.assertionCounter).toBe(platform==='ios'?3:0);
  for(const field of ['receipt','accepted','recordedAt','presence','currentIntegrity'])expect(result).not.toHaveProperty(field);
 });
 it.each(['ios','android'] as const)('requires contiguous %s claims and original predecessor digest',platform=>{
  const f=fixture(platform),first=f.check(f.signed());if(first.outcome!=='proof_valid')throw Error('missing first proof');
  const next={...f.claim,permit:f.context.permits[1],chain:{sequence:2,previousSha256:first.digest},command:{...f.claim.command,requestId:id(21),action:'in' as const}};
  expect(f.check(f.signed(next,5))).toEqual({outcome:'invalid',reason:'chain_mismatch'});
  const key={...f.key,assertionCounter:first.nextCounter??0};
  expect(verifyOfflineClockProof(f.signed(next,5),f.context,key,first.cursor)).toMatchObject({outcome:'proof_valid',cursor:{nextSequence:3}});
  expect(verifyOfflineClockProof(f.signed({...next,chain:{...next.chain,previousSha256:'d'.repeat(64)}},5),f.context,key,first.cursor)).toEqual({outcome:'invalid',reason:'chain_mismatch'});
  expect(verifyOfflineClockProof(f.signed(),f.context,key,first.cursor)).toEqual({outcome:'invalid',reason:'chain_mismatch'});
 });
 it.each(['installationId','tenantId','companyId','actorId','employmentId','appInstallationId','deviceKeyId'] as const)('binds the original %s even when another payload is correctly signed',field=>{
  const f=fixture();expect(f.check(f.signed({...f.claim,scope:{...f.claim.scope,[field]:id(99)}}))).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('binds origin, context identity/digest and exact issued permit inventory',()=>{
  const f=fixture();expect(f.check(f.signed({...f.claim,scope:{...f.claim.scope,apiOrigin:'https://other.example.com'}}))).toEqual({outcome:'invalid',reason:'scope_mismatch'});
  for(const context of [{...f.claim.context,id:id(99)},{...f.claim.context,sha256:'d'.repeat(64)}])expect(f.check(f.signed({...f.claim,context}))).toEqual({outcome:'invalid',reason:'context_mismatch'});
  for(const permit of [{...f.claim.permit,id:id(99)},{...f.claim.permit,nonce:'C'.repeat(42)+'A'}])expect(f.check(f.signed({...f.claim,permit}))).toEqual({outcome:'invalid',reason:'permit_mismatch'});
  const context={...f.context,policy:{...f.context.policy,offlineEnabled:false},permits:[]},claim={...f.claim,context:{id:context.id,sha256:hash(offlineClockContextClientData(context)).toString('hex')}};
  expect(verifyOfflineClockProof(f.signed(claim),context,f.key,f.cursor)).toEqual({outcome:'invalid',reason:'permit_mismatch'});
 });
 it.each(['id','tenantId','actorId','installationId','appInstallationId'] as const)('refuses a registered key from another %s',field=>{
  const f=fixture();expect(verifyOfflineClockProof(f.signed(),f.context,{...f.key,[field]:id(99)},f.cursor)).toEqual({outcome:'invalid',reason:'key_mismatch'});
 });
 it('does not mix iPhone environment, platform, full bundle or registered public key',()=>{
  const f=fixture();for(const key of [{...f.key,environment:'development' as const},{...f.key,appId:'KLMNOPQRST.ai.hr'},{...f.key,platform:'android' as const,environment:null,assertionCounter:0}])
   expect(verifyOfflineClockProof(f.signed(),f.context,key,f.cursor)).toEqual({outcome:'invalid',reason:'key_mismatch'});
  expect(f.check(f.signed({...f.claim,evidence:{...f.claim.evidence,appId:'hr'}}))).toEqual({outcome:'invalid',reason:'key_mismatch'});
  expect(verifyOfflineClockProof(f.signed(),f.context,{...f.key,publicKey:fixture().pair.publicKey},f.cursor)).toEqual({outcome:'invalid',reason:'invalid_proof'});
 });
 it('uses strictly increasing original Apple counters, allowing gaps but refusing replay and rollback',()=>{
  const f=fixture();for(const counter of [0,2,3])expect(f.check(f.signed(f.claim,counter))).toEqual({outcome:'invalid',reason:'replayed_counter'});
  expect(f.check(f.signed(f.claim,12))).toMatchObject({outcome:'proof_valid',nextCounter:12});
  expect(verifyOfflineClockProof(f.signed(f.claim,4),f.context,{...f.key,assertionCounter:5},f.cursor)).toEqual({outcome:'invalid',reason:'replayed_counter'});
 });
 it.each(['ios','android'] as const)('detects modified %s command, time, uncertainty, source and photo facts',platform=>{
  const f=fixture(platform),original=f.signed();
  for(const change of [{command:{...f.claim.command,lat:4}},{command:{...f.claim.command,photo:null}},{command:{...f.claim.command,requestId:id(99)}},
   {time:{...f.claim.time,claimedAt:f.claim.time.claimedAt+1}},{time:{...f.claim.time,elapsed:{status:'unknown',reason:'continuity_unknown'}}},
   {evidence:{...f.claim.evidence,mock:false}},{evidence:{...f.claim.evidence,buildVersion:'5'}}])expect(f.check({...original,claim:{...f.claim,...change}})).toEqual({outcome:'invalid',reason:'invalid_proof'});
 });
 it('leaves expired or unknown reported timing and mock indicators for explicit adjudication, without granting attendance',()=>{
  const f=fixture(),claim={...f.claim,time:{claimedAt:f.context.expiresAt+1,elapsed:{status:'unknown' as const,reason:'continuity_unknown' as const}},evidence:{...f.claim.evidence,mock:true}};
  expect(f.check(f.signed(claim))).toMatchObject({outcome:'proof_valid',authorization:'not_granted',claim});
 });
 it('refuses malformed/unbounded artifacts and client-supplied authority or counter fields',()=>{
  const f=fixture(),original=f.signed();for(const input of [null,{...original,accepted:true},{...original,nextCounter:100},{...original,proof:{...original.proof,verified:true}},
   {...original,proof:{platform:'ios',assertion:Buffer.alloc(8193).toString('base64')}},{...original,claim:{...f.claim,purpose:'attendance.clock.online'}}])
   expect(f.check(input)).toEqual({outcome:'invalid',reason:'malformed'});
  expect(f.check({...original,proof:{platform:'ios',assertion:Buffer.from('malformed').toString('base64')}})).toEqual({outcome:'invalid',reason:'invalid_proof'});
 });
 it('does not mistake malformed trusted context/key/cursor for a successfully checked proof',()=>{
  const f=fixture();for(const key of [{...f.key,publicKey:f.pair.privateKey},{...f.key,publicKey:generateKeyPairSync('ec',{namedCurve:'secp384r1'}).publicKey},{...f.key,assertionCounter:-1}])
   expect(()=>verifyOfflineClockProof(f.signed(),f.context,key,f.cursor)).toThrow(OfflineClockProofUnavailable);
  expect(()=>verifyOfflineClockProof(f.signed(),f.context,f.key,{nextSequence:2,previousSha256:null})).toThrow(OfflineClockProofUnavailable);
  expect(()=>verifyOfflineClockProof(f.signed(),{...f.context,permits:[f.context.permits[1]]},f.key,f.cursor)).toThrow(OfflineClockProofUnavailable);
 });
 it('does not accept online Android bytes, double hashing, wrong keys or noncanonical DER as offline proof',()=>{
  const f=fixture('android'),bytes=Buffer.from(offlineClockClaimClientData(f.claim));
  const online={version:1,purpose:'attendance.clock.online',scope:{apiOrigin:f.claim.scope.apiOrigin,installationId:id(3),tenantId:id(4),actorId:id(6),employmentId:id(7),deviceKeyId:id(9)},challenge:{id:id(30),nonce:'A'.repeat(43),expiresAt:f.context.expiresAt},command:f.claim.command,evidence:f.claim.evidence};
  for(const signature of [sign('sha256',Buffer.from(onlineClockClientData(online)),f.pair.privateKey),sign('sha256',hash(bytes),f.pair.privateKey),sign('sha256',bytes,fixture('android').pair.privateKey),Buffer.from('3006020100020101','hex')])
   expect(f.check({claim:f.claim,proof:{platform:'android',signature:signature.toString('base64')}})).toEqual({outcome:'invalid',reason:'invalid_proof'});
  expect(()=>checkAndroidOfflineClockSignature({publicKey:f.pair.publicKey,signature:Buffer.alloc(8),claim:online,expectedAppId:'ai.hr'})).toThrow();
 });
});
