import {generateKeyPairSync,createHash,createPublicKey,sign} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {OfflineClockContextData,OfflineClockContextRequest,offlineClockContextClientData,OFFLINE_CLOCK_CONTEXT_MAX_BYTES} from '../lib/mobile-offline-context';
import {offlineContextIssuerIdentity,signOfflineClockContext,verifyOfflineClockContextSignature,OfflineContextSigningUnavailable} from '../lib/mobile-api/offline-context-signature';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){
 const pair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(pair.privateKey),issuedAt=1793055753390;
 const context:OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',issuer:{algorithm:'ed25519',keyId:identity.keyId},
  id:id(1),requestId:id(2),requestNonce:'A'.repeat(43),scope:{apiOrigin:'https://hr.example.com',installationId:id(3),tenantId:id(4),companyId:id(5),actorId:id(6),employmentId:id(7),appInstallationId:id(8),deviceKeyId:id(9)},
  target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production'},issuedAt,expiresAt:issuedAt+3600000,
  policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:true,maximumAccuracyM:null,photoRequirement:'optional'},
  sites:[{id:id(11),name:'Office',lat:3,lng:101,radiusM:100},{id:id(10),name:'Site',lat:4,lng:102,radiusM:200}],
  attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},
  permits:[{id:id(12),ordinal:1,nonce:'A'.repeat(43)},{id:id(13),ordinal:2,nonce:'B'.repeat(42)+'A'}]};
 const issuer={...identity,validFrom:issuedAt-1,validUntil:issuedAt+86400000,revoked:false};
 return {pair,context,issuer,raw:()=>signOfflineClockContext(context,pair.privateKey)};
}
describe('actual offline server-context signatures',()=>{
 it('verifies Ed25519 context bytes against a separate trusted issuer and exact scope without granting attendance',()=>{
  const f=fixture(),raw=f.raw(),result=verifyOfflineClockContextSignature(raw,[f.issuer],f.context.scope);
  expect(result).toMatchObject({outcome:'signature_valid',context:f.context,authorization:'not_granted',digest:createHash('sha256').update(offlineClockContextClientData(f.context)).digest('hex')});
  expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
 });
 it('uses the raw public-key fingerprint and rejects signing metadata under another issuer ID',()=>{
  const f=fixture(),jwk=createPublicKey(f.pair.privateKey).export({format:'jwk'});
  expect(f.issuer.keyId).toBe(createHash('sha256').update(Buffer.from(jwk.x!,'base64url')).digest('hex'));
  expect(()=>signOfflineClockContext({...f.context,issuer:{...f.context.issuer,keyId:'c'.repeat(64)}},f.pair.privateKey)).toThrow(OfflineContextSigningUnavailable);
  expect(()=>offlineContextIssuerIdentity(f.pair.publicKey)).toThrow(OfflineContextSigningUnavailable);
 });
 it('canonicalizes the site set and object insertion order without changing signature bytes',()=>{
  const f=fixture(),reordered={...Object.fromEntries(Object.entries(f.context).reverse()),sites:[...f.context.sites].reverse()};
  expect(offlineClockContextClientData(reordered)).toBe(offlineClockContextClientData(f.context));
  expect(JSON.parse(signOfflineClockContext(reordered,f.pair.privateKey)).signature).toBe(JSON.parse(f.raw()).signature);
 });
 it.each(['installationId','tenantId','companyId','actorId','employmentId','appInstallationId','deviceKeyId'] as const)('rejects a different expected %s before treating a signature as usable',field=>{
  const f=fixture();expect(verifyOfflineClockContextSignature(f.raw(),[f.issuer],{...f.context.scope,[field]:id(99)})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('rejects altered policy, target, context, anchor request, permit, site and expected attendance bytes',()=>{
  const f=fixture(),original=JSON.parse(f.raw());
  for(const change of [{id:id(99)},{requestId:id(99)},{requestNonce:'C'.repeat(42)+'A'},{target:{...f.context.target,appId:'KLMNOPQRST.ai.hr'}},{target:{...f.context.target,environment:'development'}},{expiresAt:f.context.expiresAt+1},
   {policy:{...f.context.policy,photoRequirement:'required'}},{sites:[{...f.context.sites[0],radiusM:1000},f.context.sites[1]]},
   {attendance:{...f.context.attendance,baseline:'c'.repeat(64)}},{permits:[f.context.permits[0],{...f.context.permits[1],id:id(99)}]}])
   expect(verifyOfflineClockContextSignature(JSON.stringify({...original,context:{...f.context,...change}}),[f.issuer],f.context.scope)).toEqual({outcome:'invalid',reason:'invalid_signature'});
 });
 it('refuses self-supplied keys, unknown issuers, revoked keys and issuer validity gaps',()=>{
  const f=fixture(),other=fixture(),envelope=JSON.parse(f.raw());
  expect(verifyOfflineClockContextSignature(JSON.stringify({...envelope,publicKey:f.issuer.publicKey}),[f.issuer],f.context.scope)).toEqual({outcome:'invalid',reason:'malformed'});
  expect(verifyOfflineClockContextSignature(f.raw(),[other.issuer],f.context.scope)).toEqual({outcome:'invalid',reason:'issuer_unavailable'});
  for(const changed of [{...f.issuer,revoked:true},{...f.issuer,validFrom:f.context.issuedAt+1},{...f.issuer,validUntil:f.context.expiresAt-1}])
   expect(verifyOfflineClockContextSignature(f.raw(),[changed],f.context.scope)).toEqual({outcome:'invalid',reason:'issuer_unavailable'});
 });
 it('keeps malformed trusted registry inputs unavailable instead of reporting successful verification',()=>{
  const f=fixture();
  for(const keys of [[],[f.issuer,f.issuer],[{...f.issuer,keyId:'c'.repeat(64)}]])
   expect(()=>verifyOfflineClockContextSignature(f.raw(),keys,f.context.scope)).toThrow(OfflineContextSigningUnavailable);
 });
 it('rejects another signature, noncanonical encodings, extra authority and oversized raw input',()=>{
  const f=fixture(),envelope=JSON.parse(f.raw()),other=fixture();
  const forged=sign(null,Buffer.from(offlineClockContextClientData(f.context)),other.pair.privateKey).toString('base64url');
  expect(verifyOfflineClockContextSignature(JSON.stringify({...envelope,signature:forged}),[f.issuer],f.context.scope)).toEqual({outcome:'invalid',reason:'invalid_signature'});
  for(const raw of [f.raw()+' '.repeat(OFFLINE_CLOCK_CONTEXT_MAX_BYTES),'{',JSON.stringify({...envelope,signature:envelope.signature+'='}),JSON.stringify({...envelope,context:{...f.context,verified:true}})]){
   expect(verifyOfflineClockContextSignature(raw,[f.issuer],f.context.scope)).toEqual({outcome:'invalid',reason:'malformed'});
  }
 });
 it('does not silently approve current policy, expiry or a punch just because historical signature bytes are valid',()=>{
  const f=fixture();expect(verifyOfflineClockContextSignature(f.raw(),[f.issuer],f.context.scope)).toMatchObject({outcome:'signature_valid',authorization:'not_granted'});
  // No client wall-time argument and no attendance writer/provider/DB ports exist in this primitive.
  expect(Object.keys(verifyOfflineClockContextSignature(f.raw(),[f.issuer],f.context.scope)).sort()).toEqual(['authorization','context','digest','outcome']);
 });
 it('refuses ambiguous inventory, impossible policy windows and raw native clock fields',()=>{
  const f=fixture();
  for(const change of [{permits:[f.context.permits[1],f.context.permits[0]]},{permits:[f.context.permits[0],{...f.context.permits[1],nonce:f.context.permits[0].nonce}]},
   {sites:[f.context.sites[0],f.context.sites[0]]},{policy:{...f.context.policy,windowMs:72*3600000+1}},{expiresAt:f.context.issuedAt},{attendance:{...f.context.attendance,clockedIn:true}},
   {bootId:'12'},{policy:{...f.context.policy,offlineEnabled:false}},{sites:[]}]){
   expect(OfflineClockContextData.safeParse({...f.context,...change}).success).toBe(false);
  }
  expect(OfflineClockContextData.parse({...f.context,policy:{...f.context.policy,offlineEnabled:false},permits:[]})).toMatchObject({permits:[]});
 });
});


it('keeps context issuance requests limited to fresh nonce and existing key/installation references',()=>{
 const request={requestId:id(2),requestNonce:'A'.repeat(43),appInstallationId:id(8),keyId:id(9)};
 expect(OfflineClockContextRequest.parse(request)).toEqual(request);
 for(const extra of [{actorId:id(99)},{companyId:id(99)},{offlineEnabled:true},{windowMs:86400000},{issuedAt:1},{publicKey:'self-approved'}])
  expect(OfflineClockContextRequest.safeParse({...request,...extra}).success).toBe(false);
 const f=fixture();
 expect(OfflineClockContextData.safeParse({...f.context,target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:null}}).success).toBe(false);
 expect(OfflineClockContextData.safeParse({...f.context,target:{platform:'android',appId:'ai.hr',environment:'production'}}).success).toBe(false);
 expect(OfflineClockContextData.safeParse({...f.context,target:{platform:'android',appId:'ai.hr',environment:null}}).success).toBe(true);
});

it('does not substitute an EC signer, online purpose or another deployment origin',()=>{
 const f=fixture(),ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 expect(()=>signOfflineClockContext(f.context,ec.privateKey)).toThrow(OfflineContextSigningUnavailable);
 expect(OfflineClockContextData.safeParse({...f.context,purpose:'attendance.clock.online'}).success).toBe(false);
 expect(verifyOfflineClockContextSignature(f.raw(),[f.issuer],{...f.context.scope,apiOrigin:'https://other.example.com'})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
});
