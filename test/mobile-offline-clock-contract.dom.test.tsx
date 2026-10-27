import vector from './fixtures/mobile-integrity/offline-clock-claim-v1.json';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {OfflineClockClaimData,OfflineClockElapsed,OfflineClockSignedClaim,OfflineClockAppleAssertion,OfflineClockAndroidSignature,offlineClockClaimClientData} from '../lib/mobile-offline-clock';
import {OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture():OfflineClockClaimData{return {
 version:1,purpose:'attendance.clock.offline.claim',
 scope:{apiOrigin:'https://hr.example.com',installationId:id(1),tenantId:id(2),companyId:id(3),actorId:id(4),employmentId:id(5),appInstallationId:id(6),deviceKeyId:id(7)},
 context:{id:id(8),sha256:'a'.repeat(64)},permit:{id:id(9),ordinal:1,nonce:'A'.repeat(43)},chain:{sequence:1,previousSha256:null},
 command:{requestId:id(10),action:'in',lat:3,lng:101,accuracy:5,sampledAt:1793055753390,photo:{sha256:'b'.repeat(64),byteLength:3,mimeType:'image/jpeg'}},
 time:{claimedAt:1793055753400,elapsed:{status:'elapsed',minimumNs:'9007199254741000',maximumNs:'9007199254741010',continuity:'same_process'}},
 evidence:{platform:'ios',appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null},
};}
const hash=(value:unknown)=>createHash('sha256').update(offlineClockClaimClientData(value)).digest('hex');
describe('offline claim canonical protocol boundary',()=>{
 it('matches the fixed portable v1 byte/hash vector',()=>{
  expect(offlineClockClaimClientData(fixture())).toBe(vector.canonical);expect(hash(fixture())).toBe(vector.sha256);
 });
 it('is independent of object insertion order and canonicalizes scoped UUID case',()=>{
  const p=fixture(),reordered=Object.fromEntries(Object.entries(p).reverse());
  expect(hash(reordered)).toBe(hash(p));expect(hash({...p,scope:{...p.scope,actorId:p.scope.actorId.toUpperCase()}})).toBe(hash(p));
  expect(offlineClockClaimClientData(p)).toContain('attendance.clock.offline.claim');
 });
 it.each(['installationId','tenantId','companyId','actorId','employmentId','appInstallationId','deviceKeyId'] as const)('binds original %s scope',field=>{
  const p=fixture();expect(hash({...p,scope:{...p.scope,[field]:id(99)}})).not.toBe(hash(p));
 });
 it('binds the deployment origin and reported app/build identity',()=>{
  const p=fixture();expect(hash({...p,scope:{...p.scope,apiOrigin:'https://other.example.com'}})).not.toBe(hash(p));
  for(const change of [{appId:'other.app'},{appVersion:'2'},{buildVersion:'5'},{provider:'gps'}])expect(hash({...p,evidence:{...p.evidence,...change}})).not.toBe(hash(p));
 });
 it('binds the context, exact permit, sequence and interior chain link',()=>{
  const p=fixture();
  for(const change of [{context:{...p.context,id:id(99)}},{context:{...p.context,sha256:'c'.repeat(64)}},{permit:{...p.permit,id:id(99)}},{permit:{...p.permit,nonce:'B'.repeat(42)+'A'}},
   {permit:{...p.permit,ordinal:2},chain:{sequence:2,previousSha256:'c'.repeat(64)}}])
   expect(hash({...p,...change})).not.toBe(hash(p));
  for(const change of [{permit:{...p.permit,ordinal:2}},{chain:{sequence:2,previousSha256:null}},{chain:{sequence:1,previousSha256:'c'.repeat(64)}},{permit:{...p.permit,ordinal:33},chain:{sequence:33,previousSha256:'c'.repeat(64)}}])
   expect(OfflineClockClaimData.safeParse({...p,...change}).success).toBe(false);
 });
 it('binds action, command reference, reported fix, source facts, photo and claimed/elapsed time separately',()=>{
  const p=fixture();
  for(const command of [{...p.command,action:'out' as const},{...p.command,requestId:id(99)},{...p.command,lat:4},{...p.command,sampledAt:p.command.sampledAt+1},{...p.command,accuracy:6},{...p.command,photo:null},{...p.command,photo:{...p.command.photo!,sha256:'c'.repeat(64)}}])
   expect(hash({...p,command})).not.toBe(hash(p));
  expect(hash({...p,time:{...p.time,claimedAt:p.time.claimedAt+1}})).not.toBe(hash(p));
  expect(hash({...p,time:{...p.time,elapsed:{status:'unknown',reason:'continuity_unknown'}}})).not.toBe(hash(p));
  for(const field of ['mock','simulated','accessory'] as const)expect(hash({...p,evidence:{...p.evidence,[field]:false}})).not.toBe(hash(p));
 });
 it('retains exact bounded durations above JS integer precision without silently imposing an HR window',()=>{
  const elapsed={status:'elapsed',minimumNs:'259200000000001',maximumNs:'18446744073709551615',continuity:'same_process'};
  expect(OfflineClockElapsed.parse(elapsed)).toEqual(elapsed);
  for(const value of ['01','1\n','-1','invalid','1e9','18446744073709551616','9'.repeat(21)])expect(OfflineClockElapsed.safeParse({...elapsed,minimumNs:value}).success).toBe(false);
  expect(OfflineClockElapsed.safeParse({...elapsed,minimumNs:'9',maximumNs:'8'}).success).toBe(false);
 });
 it('rejects client authority, raw native clock snapshots and issuer-supplied verification keys in claims',()=>{
  const p=fixture();
  for(const extra of [{verified:true},{accepted:true},{trust:'strong'},{publicKey:'self-signed'}])expect(OfflineClockClaimData.safeParse({...p,...extra}).success).toBe(false);
  for(const extra of [{bootId:'12'},{runtimeId:id(99)},{wallTimeMs:123},{elapsedBeforeNs:'123'},{verification:'verified'},{verification:'not_verified'}])
   expect(OfflineClockClaimData.safeParse({...p,time:{...p.time,elapsed:{...p.time.elapsed,...extra}}}).success).toBe(false);
  expect(OfflineClockClaimData.safeParse({...p,context:{...p.context,publicKey:'self-approved'}}).success).toBe(false);
 });
 it('keeps iPhone restart continuity unknown and does not accept a fabricated iOS same-boot capability',()=>{
  const p=fixture();
  expect(OfflineClockClaimData.safeParse({...p,time:{...p.time,elapsed:{...p.time.elapsed,continuity:'same_boot'}}}).success).toBe(false);
  expect(OfflineClockClaimData.parse({...p,time:{...p.time,elapsed:{status:'unknown',reason:'boot_changed'}}}).time.elapsed).toEqual({status:'unknown',reason:'boot_changed'});
  expect(OfflineClockClaimData.safeParse({...p,evidence:{...p.evidence,platform:'android'},time:{...p.time,elapsed:{...p.time.elapsed,continuity:'same_boot'}}}).success).toBe(true);
 });
 it('cannot be interpreted as an online challenge assertion',()=>{
  const p=fixture();expect(OnlineClockIntegrityData.safeParse(p).success).toBe(false);
  expect(OfflineClockClaimData.safeParse({...p,purpose:'attendance.clock.online'}).success).toBe(false);
  expect(OfflineClockClaimData.safeParse({...p,version:2}).success).toBe(false);
 });
});

it('bounds unverified signed-claim envelopes without accepting authority, another platform or noncanonical proof bytes',()=>{
 const claim=fixture(),assertion=Buffer.from('opaque unverified artifact').toString('base64');
 expect(OfflineClockSignedClaim.parse({claim,proof:{platform:'ios',assertion}})).toMatchObject({claim,proof:{platform:'ios',assertion}});
 for(const value of [{claim,proof:{platform:'android',signature:assertion}},{claim,proof:{platform:'ios',assertion,verified:true}},{claim,proof:{platform:'ios',assertion},accepted:true},{claim,proof:{platform:'ios',assertion:'AB=='}}])
  expect(OfflineClockSignedClaim.safeParse(value).success).toBe(false);
 expect(OfflineClockAppleAssertion.safeParse(Buffer.alloc(8192,255).toString('base64')).success).toBe(true);
 expect(OfflineClockAppleAssertion.safeParse(Buffer.alloc(8193,255).toString('base64')).success).toBe(false);
 expect(OfflineClockAndroidSignature.safeParse(Buffer.alloc(72,255).toString('base64')).success).toBe(true);
 expect(OfflineClockAndroidSignature.safeParse(Buffer.alloc(73,255).toString('base64')).success).toBe(false);
 expect(offlineClockClaimClientData(claim)).toBe(vector.canonical);
});
