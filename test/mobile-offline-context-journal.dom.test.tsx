/** Shared proof-owner model with real context signatures; no OS/DB/attendance acceptance. */
import {createHash,generateKeyPairSync} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createSignedClockJournal,parseSignedClockSnapshot,SignedClockConflict,type SignedClockPorts,type SignedClockSnapshot} from '../mobile/lib/signed-clock-journal';
import {offlineContextIssuerIdentity,signOfflineClockContext,verifyOfflineClockContextSignature} from '../lib/mobile-api/offline-context-signature';
import {NativeCapabilities} from '../mobile/lib/integrity-bridge';
import {offlineClockPhotoReference,type OfflineClockProofPorts} from '../mobile/lib/offline-clock-state';
import {offlineClockClaimClientData} from '../lib/mobile-offline-clock';
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
  offline:{snapshot:vi.fn<NonNullable<SignedClockPorts['offline']>['snapshot']>(()=>({status:'evidence',evidence:snapshot(),verification:'not_verified'})),request:vi.fn(async()=>signOfflineClockContext(context,pair.privateKey)),verify:vi.fn(async(raw,expected)=>verifyOfflineClockContextSignature(raw,[issuer],expected.scope))},
 };
 return {scope,key,capability,command,snapshot,binding,context,ports,stored:()=>stored,setStored:(s:SignedClockSnapshot)=>{stored=s;},journal:()=>createSignedClockJournal(scope,ports),obsolete:()=>{current=false;},raw:()=>signOfflineClockContext(context,pair.privateKey)};
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

type CapturePorts=NonNullable<NonNullable<SignedClockPorts['offline']>['capture']>;
function captureFixture(platform:'ios'|'android'='ios',photo=true,permitCount=2){
 const f=fixture(platform),bytes=Buffer.from('synthetic photo bytes'),image=photo?{sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mimeType:'image/jpeg' as const}:null;
 f.context.permits=Array.from({length:permitCount},(_,index)=>({id:id(30+index),ordinal:index+1,nonce:Buffer.alloc(32,index+1).toString('base64url')}));
 f.ports.base=vi.fn<SignedClockPorts['base']>(async(_employment,requestId)=>({digest:'a'.repeat(64),command:{...f.command,requestId},photo:image,source:{provider:null,mock:false,simulated:null,accessory:null}}));
 const capture:CapturePorts={capabilities:vi.fn<CapturePorts['capabilities']>(()=>({status:'evidence',evidence:NativeCapabilities.parse(f.capability),verification:'not_verified'})),
  digest:vi.fn<CapturePorts['digest']>(async canonical=>createHash('sha256').update(canonical).digest('hex')),
  retainPhoto:vi.fn<CapturePorts['retainPhoto']>(async requestId=>offlineClockPhotoReference(requestId)),releaseBase:vi.fn<CapturePorts['releaseBase']>(async()=>{})};
 f.ports.offline!.capture=capture;
 const input=(requestId=id(20))=>({requestId,expectedContextId:f.context.id,claimedAt:1793055753390,eventSnapshot:f.snapshot()});
 return {...f,capture,image,input,ready:async()=>{await f.journal().reserveOffline(f.binding);await f.journal().prepareOffline(f.binding.request.requestId);}};
}
describe('durable offline claim capture and photo/base ownership transfer',()=>{
 it.each(['ios','android'] as const)('%s commits original claim before photo retention and commits photo retention before releasing its base',async platform=>{
  const f=captureFixture(platform);await f.ready();
  vi.mocked(f.capture.retainPhoto).mockImplementationOnce(async(requestId,photo)=>{
   const entry=f.stored()!.offline;if(entry?.phase!=='context_ready')throw Error('missing owner');
   expect(entry.claims[0]).toMatchObject({phase:'capture_requested',claim:{command:{requestId,photo}}});return offlineClockPhotoReference(requestId);
  });
  vi.mocked(f.capture.releaseBase).mockImplementationOnce(async reference=>{
   expect(f.stored()!.offline).toMatchObject({claims:[{phase:'photo_retained',baseDigest:reference.baseDigest}]});
  });
  expect(await f.journal().captureOffline(f.input())).toEqual({status:'captured',requestId:id(20),sequence:1,acceptance:'not_granted'});
  const exchange=f.stored()!.offline;if(exchange?.phase!=='context_ready')throw Error('missing exchange');
  const entry=exchange.claims[0];expect(entry.phase).toBe('captured');expect(entry.digest).toBe(createHash('sha256').update(offlineClockClaimClientData(entry.claim)).digest('hex'));
  expect(entry.claim).toMatchObject({scope:f.binding.scope,context:{id:f.context.id,sha256:exchange.digest},permit:f.context.permits[0],chain:{sequence:1,previousSha256:null},command:{photo:f.image}});
  expect(JSON.stringify(entry.claim)).not.toMatch(/runtimeId|bootId|elapsedBeforeNs|wallTimeMs|not_verified|nativeReference/);
  expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.complete).not.toHaveBeenCalled();expect(f.ports.play).not.toHaveBeenCalled();
 });
 it('uses the next preissued permit and immutable previous digest only after the prior local handoff is complete',async()=>{
  const f=captureFixture();await f.ready();await f.journal().captureOffline(f.input());await f.journal().captureOffline(f.input(id(21)));
  const p=f.stored()!.offline;if(p?.phase!=='context_ready')throw Error('missing');
  expect(p.claims).toHaveLength(2);expect(p.claims[1].claim).toMatchObject({permit:f.context.permits[1],chain:{sequence:2,previousSha256:p.claims[0].digest}});
  await expect(f.journal().captureOffline(f.input(id(22)))).rejects.toThrow('Signed clocking unavailable');expect(f.ports.base).toHaveBeenCalledTimes(2);
 });
 it('recovers a lost initial capture commit acknowledgement with the original event and one retained photo',async()=>{
  const f=captureFixture();await f.ready();const original=f.input();
  vi.mocked(f.ports.commit).mockImplementationOnce(async value=>{f.setStored(structuredClone(value));throw Error('acknowledgement lost');});
  await expect(f.journal().captureOffline(original)).rejects.toThrow('acknowledgement lost');expect(f.capture.retainPhoto).not.toHaveBeenCalled();
  await f.journal().captureOffline(f.input());
  expect(f.stored()!.offline).toMatchObject({claims:[{phase:'captured',eventSnapshot:original.eventSnapshot}]});
  expect(f.ports.base).toHaveBeenCalledOnce();expect(f.capture.retainPhoto).toHaveBeenCalledOnce();
 });
 it('retains the captured command and base after a photo failure and blocks a competing new claim',async()=>{
  const f=captureFixture();await f.ready();vi.mocked(f.capture.retainPhoto).mockRejectedValueOnce(Error('photo storage full'));
  await expect(f.journal().captureOffline(f.input())).rejects.toThrow('photo storage full');expect(f.capture.releaseBase).not.toHaveBeenCalled();
  await expect(f.journal().captureOffline(f.input(id(21)))).rejects.toBeInstanceOf(SignedClockConflict);
  await f.journal().captureOffline(f.input());expect(f.ports.base).toHaveBeenCalledOnce();expect(f.capture.retainPhoto).toHaveBeenCalledTimes(2);
 });
 it('does not copy another photo after the photo-retained checkpoint reply is lost',async()=>{
  const f=captureFixture();await f.ready();
  vi.mocked(f.ports.commit).mockImplementation(async value=>{f.setStored(structuredClone(value));if(value.offline?.phase==='context_ready'&&value.offline.claims[0]?.phase==='photo_retained')throw Error('photo checkpoint lost');});
  await expect(f.journal().captureOffline(f.input())).rejects.toThrow('photo checkpoint lost');expect(f.capture.releaseBase).not.toHaveBeenCalled();
  vi.mocked(f.ports.commit).mockImplementation(async value=>{f.setStored(structuredClone(value));});
  await f.journal().captureOffline(f.input());expect(f.capture.retainPhoto).toHaveBeenCalledOnce();expect(f.capture.releaseBase).toHaveBeenCalledOnce();
 });
 it('retries an ambiguous base release without retrieving the original command or copying another photo',async()=>{
  const f=captureFixture();await f.ready();vi.mocked(f.capture.releaseBase).mockRejectedValueOnce(Error('base acknowledgement lost'));
  await expect(f.journal().captureOffline(f.input())).rejects.toThrow('base acknowledgement lost');
  f.ports.base=vi.fn(async()=>{throw Error('base already gone');});
  await f.journal().captureOffline(f.input());expect(f.ports.base).not.toHaveBeenCalled();expect(f.capture.retainPhoto).toHaveBeenCalledOnce();expect(f.capture.releaseBase).toHaveBeenCalledTimes(2);
 });
 it('keeps duplicate retries idempotent and refuses altered claimed time or context identity',async()=>{
  const f=captureFixture();await f.ready();await f.journal().captureOffline(f.input());const before=structuredClone(f.stored());
  expect(await f.journal().captureOffline(f.input())).toMatchObject({status:'captured',sequence:1});expect(f.stored()).toEqual(before);
  await expect(f.journal().captureOffline({...f.input(),claimedAt:1793055753391})).rejects.toBeInstanceOf(SignedClockConflict);
  await expect(f.journal().captureOffline({...f.input(),expectedContextId:id(99)})).rejects.toBeInstanceOf(SignedClockConflict);
  expect(f.capture.retainPhoto).toHaveBeenCalledOnce();expect(f.capture.releaseBase).toHaveBeenCalledOnce();
 });
 it('preserves unknown iPhone restart timing and does not require a nonexistent photo port operation',async()=>{
  const f=captureFixture('ios',false);await f.ready();const input=f.input();input.eventSnapshot.runtimeId=id(99);
  await f.journal().captureOffline(input);
  expect(f.stored()!.offline).toMatchObject({claims:[{photoReference:null,claim:{time:{elapsed:{status:'unknown',reason:'continuity_unknown'}}}}]});expect(f.capture.retainPhoto).not.toHaveBeenCalled();
 });
 it('refuses a changed recorded digest before another base, permit or proof operation',async()=>{
  const f=captureFixture();await f.ready();await f.journal().captureOffline(f.input());const state=structuredClone(f.stored()!);if(state.offline?.phase!=='context_ready')throw Error('missing');state.offline.claims[0].digest='c'.repeat(64);f.setStored(state);
  await expect(f.journal().captureOffline(f.input(id(21)))).rejects.toThrow('Signed clocking unavailable');expect(f.ports.base).toHaveBeenCalledOnce();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('does not release the base or publish a later checkpoint after owner loss while retaining its photo',async()=>{
  const f=captureFixture();await f.ready();vi.mocked(f.capture.retainPhoto).mockImplementationOnce(async requestId=>{f.obsolete();return offlineClockPhotoReference(requestId);});
  await expect(f.journal().captureOffline(f.input())).rejects.toThrow('Session changed');expect(f.capture.releaseBase).not.toHaveBeenCalled();expect(f.stored()!.offline).toMatchObject({claims:[{phase:'capture_requested'}]});
 });
 it('serializes concurrent capture retries into one command, one permit and one photo handoff',async()=>{
  const f=captureFixture();await f.ready();const input=f.input();
  const results=await Promise.all([f.journal().captureOffline(input),f.journal().captureOffline(input)]);expect(results[0]).toEqual(results[1]);expect(f.ports.base).toHaveBeenCalledOnce();expect(f.capture.retainPhoto).toHaveBeenCalledOnce();expect(f.capture.releaseBase).toHaveBeenCalledOnce();
 });
 it('does not allocate a new claim under a revoked issuer or unsupported native capability',async()=>{
  const f=captureFixture();await f.ready();vi.mocked(f.ports.offline!.verify).mockResolvedValueOnce({outcome:'invalid',reason:'issuer_unavailable'});
  await expect(f.journal().captureOffline(f.input())).rejects.toThrow('Signed clocking unavailable');expect(f.ports.base).not.toHaveBeenCalled();
  vi.mocked(f.capture.capabilities).mockReturnValueOnce({status:'unsupported',reason:'unsupported'});
  await expect(f.journal().captureOffline(f.input())).rejects.toThrow('Signed clocking unavailable');expect(f.stored()!.offline).toMatchObject({claims:[]});expect(f.capture.retainPhoto).not.toHaveBeenCalled();
 });
});

function proofFixture(platform:'ios'|'android'='ios'){
 const f=captureFixture(platform),proof=Buffer.from('opaque unverified proof').toString('base64');
 const signing:OfflineClockProofPorts={inspect:vi.fn<OfflineClockProofPorts['inspect']>(async()=>({status:'evidence',evidence:{state:'absent'},verification:'not_verified'})),
  sign:vi.fn<OfflineClockProofPorts['sign']>(async()=>({status:'evidence',evidence:proof,verification:'not_verified'})),
  release:vi.fn<OfflineClockProofPorts['release']>(async()=>({status:'evidence',evidence:null,verification:'not_verified'})),verifyPhoto:vi.fn<OfflineClockProofPorts['verifyPhoto']>(async()=>{})};
 f.ports.offline!.signing=signing;
 return {...f,signing,proof,captured:async()=>{await f.ready();await f.journal().captureOffline(f.input());}};
}
describe('ordered offline proof generation and durable native handoff',()=>{
 it.each(['ios','android'] as const)('%s reserves SDK intent and commits proof before native cleanup without uploading attendance',async platform=>{
  const f=proofFixture(platform);await f.captured();
  vi.mocked(f.signing.inspect).mockImplementationOnce(async()=>{expect(f.stored()!.offline).toMatchObject({claims:[{phase:'signing',proof:null,nativeReleased:false}]});return {status:'evidence',evidence:{state:'absent'},verification:'not_verified'};});
  vi.mocked(f.signing.release).mockImplementationOnce(async()=>{expect(f.stored()!.offline).toMatchObject({claims:[{phase:'proof_ready',proof:f.proof,nativeReleased:false}]});return {status:'evidence',evidence:null,verification:'not_verified'};});
  expect(await f.journal().signOffline(id(20),f.context.id)).toEqual({status:'proof_ready',requestId:id(20),acceptance:'not_granted'});
  expect(f.stored()!.offline).toMatchObject({claims:[{phase:'proof_ready',proof:f.proof,nativeReleased:true}]});expect(f.signing.verifyPhoto).toHaveBeenCalledWith(id(20),f.image);
  expect(f.ports.complete).not.toHaveBeenCalled();expect(f.ports.play).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('does not inspect/sign a later claim until every earlier proof handoff is finished',async()=>{
  const f=proofFixture();await f.captured();await f.journal().captureOffline(f.input(id(21)));
  expect(await f.journal().signOffline(id(21),f.context.id)).toEqual({status:'pending',requestId:id(21),reason:'earlier_claim'});expect(f.signing.inspect).not.toHaveBeenCalled();
  await f.journal().signOffline(id(20),f.context.id);await f.journal().signOffline(id(21),f.context.id);expect(f.signing.sign).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.signing.sign).mock.calls.map(([,claim])=>claim.command.requestId)).toEqual([id(20),id(21)]);
 });
 it('recovers a completed native iPhone proof without generating again or requiring an unavailable photo',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.inspect).mockResolvedValueOnce({status:'evidence',evidence:{state:'completed',assertion:f.proof},verification:'not_verified'});
  vi.mocked(f.signing.verifyPhoto).mockRejectedValueOnce(Error('photo unavailable'));
  expect(await f.journal().signOffline(id(20),f.context.id)).toMatchObject({status:'proof_ready'});expect(f.signing.sign).not.toHaveBeenCalled();expect(f.signing.verifyPhoto).not.toHaveBeenCalled();expect(f.signing.release).toHaveBeenCalledOnce();
 });
 it('holds a live/unknown iPhone request while allowing subsequent local capture without bypassing proof order',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.inspect).mockResolvedValueOnce({status:'evidence',evidence:{state:'requested',canRetry:false},verification:'not_verified'});
  expect(await f.journal().signOffline(id(20),f.context.id)).toMatchObject({status:'pending',reason:'recovery_required'});expect(f.signing.sign).not.toHaveBeenCalled();
  await f.journal().captureOffline(f.input(id(21)));expect(await f.journal().signOffline(id(21),f.context.id)).toMatchObject({reason:'earlier_claim'});
  vi.mocked(f.signing.inspect).mockResolvedValueOnce({status:'evidence',evidence:{state:'completed',assertion:f.proof},verification:'not_verified'});
  await f.journal().signOffline(id(20),f.context.id);expect(f.signing.sign).not.toHaveBeenCalled();
 });
 it.each([{state:'retryable' as const},{state:'requested' as const,canRetry:true}])('allows explicit same-claim SDK retry only when the native recovery state permits %s',async evidence=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.inspect).mockResolvedValueOnce({status:'evidence',evidence,verification:'not_verified'});
  await f.journal().signOffline(id(20),f.context.id);expect(f.signing.sign).toHaveBeenCalledOnce();expect(vi.mocked(f.signing.sign).mock.calls[0][1].command.requestId).toBe(id(20));
 });
 it('does not generate a proof after a lost signing-reservation commit acknowledgement',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.ports.commit).mockImplementationOnce(async value=>{f.setStored(structuredClone(value));throw Error('reservation acknowledgement lost');});
  await expect(f.journal().signOffline(id(20),f.context.id)).rejects.toThrow('reservation acknowledgement lost');expect(f.signing.inspect).not.toHaveBeenCalled();expect(f.signing.sign).not.toHaveBeenCalled();
  await f.journal().signOffline(id(20),f.context.id);expect(f.signing.sign).toHaveBeenCalledOnce();
 });
 it('reuses a proof committed before a lost storage reply instead of another SDK call',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.ports.commit).mockImplementation(async value=>{f.setStored(structuredClone(value));if(value.offline?.phase==='context_ready'&&value.offline.claims[0].phase==='proof_ready')throw Error('proof acknowledgement lost');});
  await expect(f.journal().signOffline(id(20),f.context.id)).rejects.toThrow('proof acknowledgement lost');expect(f.signing.release).not.toHaveBeenCalled();
  vi.mocked(f.ports.commit).mockImplementation(async value=>{f.setStored(structuredClone(value));});
  await f.journal().signOffline(id(20),f.context.id);expect(f.signing.sign).toHaveBeenCalledOnce();expect(f.signing.inspect).toHaveBeenCalledOnce();expect(f.signing.release).toHaveBeenCalledOnce();
 });
 it('recovers a proof that reached the native cache but not the JS journal',async()=>{
  const f=proofFixture();await f.captured();let commits=0;
  vi.mocked(f.ports.commit).mockImplementation(async value=>{if(++commits===2)throw Error('proof write failed');f.setStored(structuredClone(value));});
  await expect(f.journal().signOffline(id(20),f.context.id)).rejects.toThrow('proof write failed');expect(f.stored()!.offline).toMatchObject({claims:[{phase:'signing',proof:null}]});
  vi.mocked(f.ports.commit).mockImplementation(async value=>{f.setStored(structuredClone(value));});vi.mocked(f.signing.inspect).mockResolvedValueOnce({status:'evidence',evidence:{state:'completed',assertion:f.proof},verification:'not_verified'});
  await f.journal().signOffline(id(20),f.context.id);expect(f.signing.sign).toHaveBeenCalledOnce();
 });
 it('retries uncertain native cleanup with the retained proof, without registry lookup or another SDK operation',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.release).mockRejectedValueOnce(Error('cleanup reply lost'));
  await expect(f.journal().signOffline(id(20),f.context.id)).rejects.toThrow('cleanup reply lost');
  const verifiedCalls=vi.mocked(f.ports.offline!.verify).mock.calls.length;vi.mocked(f.ports.offline!.verify).mockRejectedValueOnce(Error('registry unavailable'));
  expect(await f.journal().signOffline(id(20),f.context.id)).toMatchObject({status:'proof_ready'});expect(f.signing.sign).toHaveBeenCalledOnce();expect(f.signing.release).toHaveBeenCalledTimes(2);expect(f.ports.offline!.verify).toHaveBeenCalledTimes(verifiedCalls);
 });
 it('keeps repeated ready calls idempotent and rejects stale request/context identifiers before SDK work',async()=>{
  const f=proofFixture();await f.captured();await f.journal().signOffline(id(20),f.context.id);const before=structuredClone(f.stored());
  await f.journal().signOffline(id(20),f.context.id);expect(f.stored()).toEqual(before);expect(f.signing.sign).toHaveBeenCalledOnce();expect(f.signing.release).toHaveBeenCalledOnce();
  await expect(f.journal().signOffline(id(99),f.context.id)).rejects.toBeInstanceOf(SignedClockConflict);await expect(f.journal().signOffline(id(20),id(99))).rejects.toBeInstanceOf(SignedClockConflict);
 });
 it('keeps missing photos and native failures pending without signing another claim or inventing proof bytes',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.verifyPhoto).mockRejectedValueOnce(Error('photo unavailable'));
  await expect(f.journal().signOffline(id(20),f.context.id)).rejects.toThrow('photo unavailable');expect(f.signing.sign).not.toHaveBeenCalled();
  vi.mocked(f.signing.sign).mockResolvedValueOnce({status:'unsupported',reason:'unsupported'});expect(await f.journal().signOffline(id(20),f.context.id)).toMatchObject({status:'pending',reason:'unsupported'});
  expect(f.stored()!.offline).toMatchObject({claims:[{phase:'signing',proof:null,nativeReleased:false}]});expect(f.signing.release).not.toHaveBeenCalled();
 });
 it('refuses malformed proof bytes and an Android claim masquerading as an Apple cached assertion',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.sign).mockResolvedValueOnce({status:'evidence',evidence:'AB==',verification:'not_verified'});
  expect(await f.journal().signOffline(id(20),f.context.id)).toMatchObject({status:'pending',reason:'invalid_evidence'});expect(f.signing.release).not.toHaveBeenCalled();
  const g=proofFixture('android');await g.captured();vi.mocked(g.signing.inspect).mockResolvedValueOnce({status:'evidence',evidence:{state:'completed',assertion:g.proof},verification:'not_verified'});
  expect(await g.journal().signOffline(id(20),g.context.id)).toMatchObject({status:'pending',reason:'invalid_evidence'});expect(g.signing.sign).not.toHaveBeenCalled();
 });
 it('does not save returned proof or release native custody after ownership changes during the SDK operation',async()=>{
  const f=proofFixture();await f.captured();vi.mocked(f.signing.sign).mockImplementationOnce(async()=>{f.obsolete();return {status:'evidence',evidence:f.proof,verification:'not_verified'};});
  await expect(f.journal().signOffline(id(20),f.context.id)).rejects.toThrow('Session changed');expect(f.signing.release).not.toHaveBeenCalled();expect(f.stored()!.offline).toMatchObject({claims:[{phase:'signing',proof:null}]});
 });
 it('refuses corrupted proof phases, claimed scope or fake cleanup flags rather than opening a new owner',async()=>{
  const f=proofFixture();await f.captured();const snapshot=structuredClone(f.stored()!);if(snapshot.offline?.phase!=='context_ready')throw Error('missing');const entry=snapshot.offline.claims[0];
  for(const change of [{nativeReleased:true},{proof:f.proof},{phase:'proof_ready',proof:null},{claim:{...entry.claim,scope:{...entry.claim.scope,companyId:id(99)}}}]){
   expect(()=>parseSignedClockSnapshot({...snapshot,offline:{...snapshot.offline,claims:[{...entry,...change}]}},f.scope)).toThrow('Signed clocking unavailable');
  }
 });
});

it('refuses persisted out-of-order proof state or native-cleanup claims before opening SDK ownership',async()=>{
 const f=proofFixture();await f.captured();await f.journal().captureOffline(f.input(id(21)));const snapshot=structuredClone(f.stored()!);if(snapshot.offline?.phase!=='context_ready')throw Error('missing');
 for(const change of [{phase:'signing',proof:null,nativeReleased:false},{phase:'proof_ready',proof:f.proof,nativeReleased:true}]){
  const claims=snapshot.offline.claims.map((entry,index)=>index===1?{...entry,...change}:entry);
  expect(()=>parseSignedClockSnapshot({...snapshot,offline:{...snapshot.offline,claims}},f.scope)).toThrow('Signed clocking unavailable');
 }
});
