/** Shared proof-owner model with real context signatures; no OS/DB/attendance acceptance. */
import {generateKeyPairSync} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createSignedClockJournal,parseSignedClockSnapshot,SignedClockConflict,type SignedClockPorts,type SignedClockSnapshot} from '../mobile/lib/signed-clock-journal';
import {offlineContextIssuerIdentity,signOfflineClockContext,verifyOfflineClockContextSignature} from '../lib/mobile-api/offline-context-signature';
import type {OfflineClockContextData,OfflineClockContextBinding} from '../lib/mobile-offline-context';
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(platform:'ios'|'android'='ios'){
 let stored:SignedClockSnapshot|null=null,current=true,counter=100;
 const scope={namespace:'fixture',apiOrigin:'https://hr.example.com',actorId:id(6),appInstallationId:id(8)};
 const key={platform,apiOrigin:scope.apiOrigin,actorId:scope.actorId,appInstallationId:scope.appInstallationId,installationId:id(3),tenantId:id(4),keyId:id(9),appId:platform==='ios'?'ABCDEFGHIJ.ai.hr':'ai.hr',nativeReference:platform==='ios'?Buffer.alloc(32,7).toString('base64'):'aihr_'+'a'.repeat(64)};
 const capability={version:1,platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:platform==='ios'?'apple_app_attest':'android_keystore'};
 const binding:OfflineClockContextBinding={scope:{apiOrigin:scope.apiOrigin,actorId:scope.actorId,appInstallationId:scope.appInstallationId,installationId:id(3),tenantId:id(4),companyId:id(5),employmentId:id(7),deviceKeyId:id(9)},request:{requestId:id(2),requestNonce:'A'.repeat(43),appInstallationId:id(8),keyId:id(9)},target:platform==='ios'?{platform:'ios',appId:key.appId,environment:'production'}:{platform:'android',appId:key.appId,environment:null}};
 const pair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(pair.privateKey),issuedAt=1793055753390;
 const context:OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',issuer:{algorithm:'ed25519',keyId:identity.keyId},id:id(1),requestId:binding.request.requestId,requestNonce:binding.request.requestNonce,
  scope:binding.scope,target:binding.target,issuedAt,expiresAt:issuedAt+3600000,policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},sites:[],
  attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},permits:[{id:id(11),ordinal:1,nonce:'A'.repeat(43)}]};
 const issuer={...identity,validFrom:issuedAt-1,validUntil:issuedAt+86400000,revoked:false};
 const snapshot=()=>({localOnly:true as const,runtimeId:id(12),source:platform==='ios'?'ios_continuous' as const:'android_elapsed_realtime' as const,elapsedBeforeNs:String(counter+=10),elapsedAfterNs:String(counter+1),wallTimeMs:issuedAt,bootId:platform==='ios'?null:'1'});
 const command={requestId:id(20),action:'in' as const,lat:3,lng:101,accuracy:5,sampledAt:issuedAt};
 const source={provider:null,mock:null,simulated:null,accessory:null};
 const ports:SignedClockPorts={assertCurrent(){if(!current)throw Error('Session changed');},read:vi.fn(async()=>stored),commit:vi.fn(async value=>{stored=structuredClone(value);}),
  base:vi.fn(async()=>({digest:'a'.repeat(64),command,photo:null,source})),key:vi.fn(async()=>({key,capability})) as SignedClockPorts['key'],
  capabilities:vi.fn(async()=>({outcome:'capabilities',protocol:2,platform,commandProtocol:platform==='ios'?1:2,features:platform==='ios'?['online_clock_assertion']:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:platform==='ios'?null:'123456789'})),
  begin:vi.fn(async()=>({})),sign:vi.fn(async()=>({status:'unavailable' as const,reason:'unavailable' as const})),play:vi.fn(async()=>({status:'unavailable' as const,reason:'unavailable' as const})),complete:vi.fn(async()=>({})),receipt:vi.fn(async()=>({})),abandon:vi.fn(async()=>({})),resolveBase:vi.fn(async()=>{}),
  offline:{snapshot:vi.fn(()=>({status:'evidence',evidence:snapshot(),verification:'not_verified'})),request:vi.fn(async()=>signOfflineClockContext(context,pair.privateKey)),verify:vi.fn(async(raw,expected)=>verifyOfflineClockContextSignature(raw,[issuer],expected.scope))},
 };
 return {scope,key,binding,context,ports,stored:()=>stored,setStored:(s:SignedClockSnapshot)=>{stored=s;},journal:()=>createSignedClockJournal(scope,ports),obsolete:()=>{current=false;},raw:()=>signOfflineClockContext(context,pair.privateKey)};
}
describe('shared online/offline context exchange owner',()=>{
 it.each(['ios','android'] as const)('%s saves request and original local snapshot before any network/verification operation',async platform=>{
  const f=fixture(platform),j=f.journal();
  expect(await j.reserveOffline(f.binding)).toEqual({status:'offline_pending',requestId:f.binding.request.requestId,phase:'context_requested'});
  expect(f.ports.offline!.request).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
  const original=f.stored()!.offline!.requestStarted;
  vi.mocked(f.ports.offline!.request).mockImplementationOnce(async()=>{
   expect(f.stored()!.offline).toMatchObject({phase:'context_requested',requestStarted:original});return f.raw();
  });
  await j.prepareOffline(f.binding.request.requestId);
  expect(f.stored()!.offline).toMatchObject({phase:'context_ready',requestStarted:original});
  expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.play).not.toHaveBeenCalled();expect(f.ports.complete).not.toHaveBeenCalled();
 });
 it('keeps the original request, nonce and snapshot across a failed response and restart',async()=>{
  const f=fixture();await f.journal().reserveOffline(f.binding);const before=structuredClone(f.stored());
  vi.mocked(f.ports.offline!.request).mockRejectedValueOnce(Error('connection lost'));
  await expect(f.journal().prepareOffline(f.binding.request.requestId)).rejects.toThrow('connection lost');expect(f.stored()).toEqual(before);
  await f.journal().prepareOffline(f.binding.request.requestId);
  expect(f.stored()!.offline!.requestStarted).toEqual(before!.offline!.requestStarted);expect(f.ports.offline!.snapshot).toHaveBeenCalledTimes(2);
  expect(f.ports.offline!.request).toHaveBeenNthCalledWith(2,f.binding);
 });
 it('blocks online start/advance/recovery and other employment while offline owns the journal',async()=>{
  const f=fixture();await f.journal().reserveOffline(f.binding);
  await expect(f.journal().start(id(7),id(20))).rejects.toBeInstanceOf(SignedClockConflict);
  expect(await f.journal().advance(id(7))).toMatchObject({status:'offline_pending'});
  expect(await f.journal().recover(id(7),true)).toMatchObject({status:'offline_pending'});
  expect(await f.journal().status(id(99))).toEqual({status:'other_pending'});
  for(const port of [f.ports.base,f.ports.receipt,f.ports.abandon,f.ports.sign,f.ports.begin])expect(port).not.toHaveBeenCalled();
 });
 it('blocks offline acquisition behind an existing online intent',async()=>{
  const f=fixture();await f.journal().start(id(7),id(20));
  await expect(f.journal().reserveOffline(f.binding)).rejects.toBeInstanceOf(SignedClockConflict);
  expect(f.ports.offline!.snapshot).not.toHaveBeenCalled();expect(f.ports.offline!.request).not.toHaveBeenCalled();
 });
 it('refuses another request/nonce/scope without overwriting the existing exchange',async()=>{
  const f=fixture();await f.journal().reserveOffline(f.binding);const before=structuredClone(f.stored());
  for(const change of [{request:{...f.binding.request,requestId:id(99)}},{request:{...f.binding.request,requestNonce:'B'.repeat(42)+'A'}},{scope:{...f.binding.scope,employmentId:id(99)}}])
   await expect(f.journal().reserveOffline({...f.binding,...change})).rejects.toBeInstanceOf(SignedClockConflict);
  await expect(f.journal().prepareOffline(id(99))).rejects.toBeInstanceOf(SignedClockConflict);
  expect(f.stored()).toEqual(before);expect(f.ports.offline!.request).not.toHaveBeenCalled();
 });
 it('reverifies a ready context without replacing its response anchor or requesting another context',async()=>{
  const f=fixture();await f.journal().reserveOffline(f.binding);await f.journal().prepareOffline(f.binding.request.requestId);const before=structuredClone(f.stored());
  await f.journal().prepareOffline(f.binding.request.requestId);expect(f.stored()).toEqual(before);expect(f.ports.offline!.request).toHaveBeenCalledOnce();expect(f.ports.offline!.verify).toHaveBeenCalledTimes(2);
  vi.mocked(f.ports.offline!.verify).mockResolvedValueOnce({outcome:'invalid',reason:'issuer_unavailable'});
  await expect(f.journal().prepareOffline(f.binding.request.requestId)).rejects.toThrow('Signed clocking unavailable');expect(f.stored()).toEqual(before);
 });
 it('does not request a context after a lost reservation commit acknowledgement or owner loss',async()=>{
  const f=fixture();vi.mocked(f.ports.commit).mockImplementationOnce(async value=>{f.setStored(structuredClone(value));throw Error('acknowledgement lost');});
  await expect(f.journal().reserveOffline(f.binding)).rejects.toThrow('acknowledgement lost');expect(f.ports.offline!.request).not.toHaveBeenCalled();
  f.obsolete();await expect(f.journal().prepareOffline(f.binding.request.requestId)).rejects.toThrow('Session changed');expect(f.ports.offline!.request).not.toHaveBeenCalled();
 });
 it('does not commit a response or call verification after ownership changes in the request',async()=>{
  const f=fixture();await f.journal().reserveOffline(f.binding);const before=structuredClone(f.stored());
  vi.mocked(f.ports.offline!.request).mockImplementationOnce(async()=>{f.obsolete();return f.raw();});
  await expect(f.journal().prepareOffline(f.binding.request.requestId)).rejects.toThrow('Session changed');expect(f.stored()).toEqual(before);expect(f.ports.offline!.verify).not.toHaveBeenCalled();
 });
 it('refuses a valid signature with substituted request binding before saving a ready context',async()=>{
  const f=fixture();await f.journal().reserveOffline(f.binding);const before=structuredClone(f.stored());f.context.requestNonce='B'.repeat(42)+'A';
  await expect(f.journal().prepareOffline(f.binding.request.requestId)).rejects.toThrow();expect(f.stored()).toEqual(before);
 });
 it('reads legacy online state into v2 without changing the pending intent and refuses conflicting dual owners',async()=>{
  const f=fixture();await f.journal().start(id(7),id(20));const current=f.stored()!,{offline,...old}=current;
  expect(parseSignedClockSnapshot({...old,version:1},f.scope)).toEqual(current);
  const other=fixture();await other.journal().reserveOffline(other.binding);
  expect(()=>parseSignedClockSnapshot({...current,offline:other.stored()!.offline},f.scope)).toThrow('Signed clocking unavailable');
 });
 it('keeps unsupported clocks, wrong scope and absent offline ports unavailable without requesting',async()=>{
  const f=fixture();vi.mocked(f.ports.offline!.snapshot).mockReturnValueOnce({status:'unsupported',reason:'unsupported'});
  await expect(f.journal().reserveOffline(f.binding)).rejects.toThrow('Signed clocking unavailable');expect(f.stored()).toBeNull();
  await expect(f.journal().reserveOffline({...f.binding,scope:{...f.binding.scope,actorId:id(99)}})).rejects.toThrow();expect(f.stored()).toBeNull();
  f.ports.offline=undefined;await expect(f.journal().reserveOffline(f.binding)).rejects.toThrow('Signed clocking unavailable');
 });
});

it('serializes competing offline reservations across controller instances and retains one original anchor',async()=>{
 const f=fixture(),other={...f.binding,request:{...f.binding.request,requestId:id(99)}};
 const results=await Promise.allSettled([f.journal().reserveOffline(f.binding),f.journal().reserveOffline(other)]);
 expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);expect(f.stored()!.offline!.binding).toEqual(f.binding);
 expect(f.ports.offline!.snapshot).toHaveBeenCalledOnce();expect(f.ports.offline!.request).not.toHaveBeenCalled();
});
it('refuses a corrupt local source, stored scope or unsigned ready-context substitution instead of opening an empty owner',async()=>{
 const f=fixture();await f.journal().reserveOffline(f.binding);const stored=f.stored()!,offline=stored.offline!;
 for(const changed of [{...offline,key:{...offline.key,actorId:id(99)}},{...offline,requestStarted:{...offline.requestStarted,source:'android_elapsed_realtime',bootId:'1'}},{...offline,binding:{...offline.binding,scope:{...offline.binding.scope,actorId:id(99)}}}])
  expect(()=>parseSignedClockSnapshot({...stored,offline:changed},f.scope)).toThrow('Signed clocking unavailable');
});

it('retains the exact legacy proof/context when normalizing an unresolved online proof into the shared v2 owner',async()=>{
 const f=fixture();await f.journal().start(id(7),id(20));const current=f.stored()!,proof=Buffer.from('original proof').toString('base64');
 const context={version:1,purpose:'attendance.clock.online',scope:{apiOrigin:f.scope.apiOrigin,installationId:id(3),tenantId:id(4),actorId:id(6),employmentId:id(7),deviceKeyId:id(9)},challenge:{id:id(1),nonce:'A'.repeat(43),expiresAt:1793055873390},
 command:{requestId:id(20),action:'in',lat:3,lng:101,accuracy:5,sampledAt:1793055753390,photo:null},evidence:{platform:'ios',appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 const parsed=parseSignedClockSnapshot({version:1,revision:3,scope:f.scope,pending:{...current.pending,phase:'proof_ready',context,proof}},f.scope);
 expect(parsed).toMatchObject({version:2,offline:null,pending:{phase:'proof_ready',context,proof}});expect(f.ports.sign).not.toHaveBeenCalled();
});
