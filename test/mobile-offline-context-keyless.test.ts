/** Owner decision D16 (29 October 2026): offline attendance is keyless on the server. Formerly the server-signature test
 * (lib/mobile-api/offline-context-signature.ts, now deleted). It now pins the context contract the server records and
 * the phone checks: strict shape, canonical bytes and digest, the binding check, and that no offline module reads a
 * signing key or signs anything. The stored-record checks themselves run on the database in
 * test/mobile-offline-context-issuance.test.ts and test/mobile-offline-claim-consumption.test.ts. No DB, no network. */
import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {OfflineClockContextData,OfflineClockContextRequest,bindOfflineClockContext,offlineClockContextClientData,offlineClockContextJson,parseOfflineClockContextJson,
 OFFLINE_CLOCK_CONTEXT_MAX_BYTES} from '../lib/mobile-offline-context';
import {MobileOfflineRolloutPolicy} from '../lib/mobile-offline-rollout-policy';
import {OfflineCapabilitiesResult} from '../lib/mobile-offline-contract';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
function fixture(){
 const issuedAt=1793055753390;
 const context:OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',
  id:id(1),requestId:id(2),requestNonce:'A'.repeat(43),scope:{apiOrigin:'https://hr.example.com',installationId:id(3),tenantId:id(4),companyId:id(5),actorId:id(6),employmentId:id(7),appInstallationId:id(8),deviceKeyId:id(9)},
  target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production'},issuedAt,expiresAt:issuedAt+3600000,
  policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:true,maximumAccuracyM:null,photoRequirement:'optional'},
  sites:[{id:id(11),name:'Office',lat:3,lng:101,radiusM:100},{id:id(10),name:'Site',lat:4,lng:102,radiusM:200}],
  attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},
  permits:[{id:id(12),ordinal:1,nonce:'A'.repeat(43)},{id:id(13),ordinal:2,nonce:'B'.repeat(42)+'A'}]};
 const binding={scope:context.scope,request:{requestId:context.requestId,requestNonce:context.requestNonce,appInstallationId:context.scope.appInstallationId,keyId:context.scope.deviceKeyId},target:context.target};
 return {context,binding,raw:()=>offlineClockContextJson(context)};
}
describe('keyless offline context contract (owner decision D16)',()=>{
 it('hands out canonical JSON that round-trips byte for byte, with a digest over the positional bytes and no issuer or signature',()=>{
  const f=fixture(),raw=f.raw();
  expect(parseOfflineClockContextJson(raw)).toEqual(f.context);expect(offlineClockContextJson(parseOfflineClockContextJson(raw))).toBe(raw);
  expect(Object.keys(JSON.parse(raw))).not.toContain('issuer');expect(Object.keys(JSON.parse(raw))).not.toContain('signature');
  // The positional bytes carry no issuer element: the fourth element is the context/request identity.
  expect(JSON.parse(offlineClockContextClientData(f.context))[3]).toEqual([f.context.id,f.context.requestId,f.context.requestNonce]);
  expect(bindOfflineClockContext(raw,f.binding)).toEqual({outcome:'bound',context:f.context,canonical:offlineClockContextClientData(f.context)});
 });
 it('canonicalizes the site set and object insertion order in the digest bytes, but records only the exact canonical text',()=>{
  const f=fixture(),reordered={...Object.fromEntries(Object.entries(f.context).reverse()),sites:[...f.context.sites].reverse()};
  expect(offlineClockContextClientData(reordered)).toBe(offlineClockContextClientData(f.context));
  // Key order is schema order once parsed; the site array order is kept in the JSON text (and ignored by the digest).
  expect(offlineClockContextJson(Object.fromEntries(Object.entries(f.context).reverse()))).toBe(f.raw());
  for(const raw of [JSON.stringify(Object.fromEntries(Object.entries(f.context).reverse())),f.raw()+' ',' '+f.raw(),JSON.stringify(f.context,null,1)])
   expect(()=>parseOfflineClockContextJson(raw)).toThrow();
 });
 it('refuses the retired signed envelope, issuer fields and any self-supplied key as malformed',()=>{
  const f=fixture(),context=JSON.parse(f.raw());
  for(const raw of [JSON.stringify({context,signature:'A'.repeat(86)}),JSON.stringify({...context,issuer:{algorithm:'ed25519',keyId:'c'.repeat(64)}}),JSON.stringify({...context,publicKey:'A'.repeat(43)}),JSON.stringify({...context,verified:true})])
   expect(bindOfflineClockContext(raw,f.binding)).toEqual({outcome:'invalid',reason:'malformed'});
  expect(OfflineClockContextData.safeParse({...f.context,issuer:{algorithm:'ed25519',keyId:'c'.repeat(64)}}).success).toBe(false);
 });
 it.each(['installationId','tenantId','companyId','actorId','employmentId','appInstallationId','deviceKeyId','apiOrigin'] as const)('refuses a context bound to a different %s',field=>{
  const f=fixture(),scope={...f.binding.scope,[field]:field==='apiOrigin'?'https://other.example.com':id(99)};
  const request={...f.binding.request,appInstallationId:scope.appInstallationId,keyId:scope.deviceKeyId};
  expect(bindOfflineClockContext(f.raw(),{...f.binding,scope,request})).toEqual({outcome:'invalid',reason:'scope_mismatch'});
 });
 it('compares the binding by field, not by object key order, and throws on a malformed trusted binding',()=>{
  const f=fixture(),reordered={...f.binding,scope:Object.fromEntries(Object.entries(f.binding.scope).reverse()) as typeof f.binding.scope};
  expect(bindOfflineClockContext(f.raw(),reordered)).toMatchObject({outcome:'bound'});
  // The binding's own consistency rule: request key/app installation must be the scope's.
  expect(()=>bindOfflineClockContext(f.raw(),{...f.binding,request:{...f.binding.request,keyId:id(99)}})).toThrow();
 });
 it('refuses another request id or nonce, and another app, platform or environment',()=>{
  const f=fixture();
  for(const request of [{...f.binding.request,requestId:id(99)},{...f.binding.request,requestNonce:'C'.repeat(42)+'A'}])
   expect(bindOfflineClockContext(f.raw(),{...f.binding,request})).toEqual({outcome:'invalid',reason:'request_mismatch'});
  for(const target of [{...f.context.target,appId:'KLMNOPQRST.ai.hr'},{...f.context.target,environment:'development' as const},{platform:'android' as const,appId:'ai.hr',environment:null}] as unknown as (typeof f.binding.target)[])
   expect(bindOfflineClockContext(f.raw(),{...f.binding,target})).toEqual({outcome:'invalid',reason:'target_mismatch'});
 });
 it('gives every altered field another digest, so a claim naming altered bytes can never match the server record',()=>{
  const f=fixture(),original=sha(offlineClockContextClientData(f.context));
  const changes=[{id:id(99)},{requestId:id(99)},{requestNonce:'C'.repeat(42)+'A'},{target:{...f.context.target,appId:'KLMNOPQRST.ai.hr'}},{target:{...f.context.target,environment:'development' as const}},{expiresAt:f.context.expiresAt+1},
   {policy:{...f.context.policy,photoRequirement:'required' as const}},{sites:[{...f.context.sites[0],radiusM:1000},f.context.sites[1]]},
   {attendance:{...f.context.attendance,baseline:'c'.repeat(64)}},{permits:[f.context.permits[0],{...f.context.permits[1],id:id(99)}]},{scope:{...f.context.scope,companyId:id(99)}}];
  const digests=changes.map(change=>sha(offlineClockContextClientData({...f.context,...change})));
  expect(digests).toHaveLength(changes.length);expect(new Set([original,...digests]).size).toBe(changes.length+1);
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
 it('bounds raw input before parsing',()=>{
  const f=fixture();
  for(const raw of [f.raw()+' '.repeat(OFFLINE_CLOCK_CONTEXT_MAX_BYTES),'{','null','[]',42 as unknown as string])expect(bindOfflineClockContext(raw,f.binding)).toEqual({outcome:'invalid',reason:'malformed'});
  expect(()=>offlineClockContextJson({...f.context,sites:Array.from({length:33},(_,i)=>({...f.context.sites[0],id:id(100+i)}))})).toThrow();
 });
 it('keeps context issuance requests limited to fresh nonce and existing key/installation references',()=>{
  const request={requestId:id(2),requestNonce:'A'.repeat(43),appInstallationId:id(8),keyId:id(9)};
  expect(OfflineClockContextRequest.parse(request)).toEqual(request);
  for(const extra of [{actorId:id(99)},{companyId:id(99)},{offlineEnabled:true},{windowMs:86400000},{issuedAt:1},{publicKey:'self-approved'},{issuer:{keyId:'c'.repeat(64)}}])
   expect(OfflineClockContextRequest.safeParse({...request,...extra}).success).toBe(false);
  const f=fixture();
  expect(OfflineClockContextData.safeParse({...f.context,target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:null}}).success).toBe(false);
  expect(OfflineClockContextData.safeParse({...f.context,target:{platform:'android',appId:'ai.hr',environment:'production'}}).success).toBe(false);
  expect(OfflineClockContextData.safeParse({...f.context,target:{platform:'android',appId:'ai.hr',environment:null}}).success).toBe(true);
  expect(OfflineClockContextData.safeParse({...f.context,purpose:'attendance.clock.online'}).success).toBe(false);
 });
 it('carries no issuer facts in the deployment policy or the capabilities contract',()=>{
  const policy={version:1,mode:'active',windowMs:86400000,permitCount:8,maximumIssuesPerHour:4,photoRetentionMs:2592000000,entries:[]};
  expect(MobileOfflineRolloutPolicy.safeParse(policy).success).toBe(true);
  for(const retired of [{signingKeyId:'a'.repeat(64)},{issuers:[{keyId:'a'.repeat(64),publicKey:'A'.repeat(43),validFrom:1,validUntil:2,revoked:false}]}])
   expect(MobileOfflineRolloutPolicy.safeParse({...policy,...retired}).success).toBe(false);
  const capabilities=OfflineCapabilitiesResult.parse({outcome:'offline',enabled:true,apiOrigin:'https://hr.example.com',companyId:id(5),issuers:[],windowMs:86400000,permitCount:8});
  expect(capabilities).toEqual({outcome:'offline',enabled:true,apiOrigin:'https://hr.example.com',companyId:id(5),windowMs:86400000,permitCount:8});
 });
});

/** Every offline module, server and phone: the files whose name says offline (or the shared signed-clock journal and
 * ports) under the kernel, contracts, mobile API, attendance pack, native client and offline routes/screens. */
function offlineModules(){
 const flat=['core','lib','lib/mobile-api','packs/attendance','mobile/lib'].flatMap(dir=>readdirSync(dir).filter(name=>/offline|signed-clock/.test(name)&&/\.tsx?$/.test(name)).map(name=>join(dir,name)));
 const walk=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{const path=join(dir,name);return statSync(path).isDirectory()?walk(path):/\.tsx?$/.test(name)?[path]:[];});
 const routes=['app/api/mobile/v2/integrity/ios/offline','app/api/mobile/v2/integrity/android/offline','app/(app)/attendance/offline-claims'].flatMap(walk);
 const screens=['app/(app)/attendance/application-history','app/(app)/admin/attendance-policy'].flatMap(dir=>readdirSync(dir).filter(name=>name.startsWith('offline')).map(name=>join(dir,name)));
 return [...flat,...routes,...screens].sort();
}
describe('no offline module reads a signing key or signs (owner decision D16)',()=>{
 const files=offlineModules();
 it('finds the whole offline module set before asserting anything about it',()=>{
  // Non-vacuous: a renamed directory or filter would otherwise turn every check below into a no-op.
  expect(files.length).toBeGreaterThanOrEqual(40);
  for(const required of ['core/mobile-offline-context.ts','core/mobile-offline-claim.ts','core/mobile-offline-rollout.ts','lib/mobile-offline-context.ts','lib/mobile-offline-rollout-policy.ts',
   'lib/mobile-offline-contract.ts','lib/mobile-api/deployed-offline-clock.ts','lib/mobile-api/offline-clock-proof.ts','packs/attendance/mobile-offline-adjudicator.ts',
   'mobile/lib/offline-context.ts','mobile/lib/offline-clock-ports.ts','mobile/lib/offline-anchor.ts','mobile/lib/signed-clock-journal.ts','mobile/lib/offline-sync.ts',
   'app/api/mobile/v2/integrity/ios/offline/context/route.ts','app/api/mobile/v2/integrity/android/offline/claim/route.ts'])expect(files).toContain(required);
  for(const file of files)expect(readFileSync(file,'utf8').length,file).toBeGreaterThan(100);
 });
 it('never reads AIHR_MOBILE_OFFLINE_SIGNING_KEY, imports a signer or a Noble curve, or names the retired registry cache',()=>{
  expect(existsSync('lib/mobile-api/offline-context-signature.ts')).toBe(false);
  const signerNames=new Set(['sign','createSign','createPrivateKey','generateKeyPair','generateKeyPairSync','createSecretKey']);
  for(const file of files){
   const source=readFileSync(file,'utf8');
   expect(source,file).not.toContain('AIHR_MOBILE_OFFLINE_SIGNING_KEY');
   expect(source,file).not.toMatch(/offline-context-signature|offline-issuers|IssuerRegistry|@noble\//);
   expect(source,file).not.toMatch(/import\s+(\*\s+as\s+)?\w+\s+from\s+'(node:)?crypto'|require\(\s*'(node:)?crypto'\s*\)/);
   for(const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?crypto'/g)){
    const names=match[1].split(',').map(name=>name.trim().replace(/^type\s+/,'').split(/\s+as\s+/)[0]).filter(Boolean);
    for(const name of names)expect(signerNames.has(name),file+' imports '+name).toBe(false);
   }
  }
 });
 it('still finds node:crypto imports to inspect, so the import check above is not vacuous',()=>{
  const importing=files.filter(file=>/import\s*\{[^}]*\}\s*from\s*'node:crypto'/.test(readFileSync(file,'utf8')));
  expect(importing).toContain('core/mobile-offline-context.ts');expect(importing).toContain('core/mobile-offline-claim.ts');
 });
});
