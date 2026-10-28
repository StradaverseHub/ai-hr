/** Offline sync engine (owner decisions 1-7, 2026-10-28): the shipped journal with real context signatures, the shipped
 * driver (offline-sync.ts), ports (offline-clock-ports.ts) and anchor (offline-anchor.ts) executed through the VM with
 * synthetic OS, storage and server. A synthetic server is not the real claim service: no attendance acceptance is shown. */
import {createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind} from 'typescript';
import {z} from 'zod';
import {describe,it,expect,vi} from 'vitest';
import * as journalModule from '../mobile/lib/signed-clock-journal';
import {createSignedClockJournal,SignedClockConflict,OFFLINE_NOTHING_ISSUED,type SignedClockPorts,type SignedClockSnapshot} from '../mobile/lib/signed-clock-journal';
import * as errors from '../mobile/lib/errors';
import * as hashModule from '../mobile/lib/offline-sync-hash';
import {NativeCapabilities} from '../mobile/lib/integrity-bridge';
import {offlineClockPhotoReference} from '../mobile/lib/offline-clock-state';
import {offlineContextIssuerIdentity,signOfflineClockContext,verifyOfflineClockContextSignature} from '../lib/mobile-api/offline-context-signature';
import {offlineSyncRequestHash} from '../lib/mobile-api/offline-sync-integrity';
import * as offlineContract from '../lib/mobile-offline-contract';
import * as offlineClock from '../lib/mobile-offline-clock';
import * as keyEnrollment from '../lib/mobile-key-enrollment';
import * as offlineContext from '../lib/mobile-offline-context';
import type {OfflineClockContextBinding,OfflineClockContextData} from '../lib/mobile-offline-context';
import type {OfflineClockSignedClaim} from '../lib/mobile-offline-clock';

const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const apiOrigin='https://hr.example.com',issuedAt=1793055753390,employmentId=id(7);
type Answer={outcome:'refused'|'unavailable';code:string;integrityReason?:string};
class ServerAnswer extends Error{constructor(readonly answer:Answer){super('Offline context not issued');}}
function compile<T>(path:string,modules:Record<string,unknown>,globals:Record<string,unknown>={}):T{
 const output={exports:{}};
 runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,{exports:output.exports,module:output,...globals,
  require:(name:string)=>{if(Object.hasOwn(modules,name))return modules[name];throw new Error('Unexpected dependency: '+name);}});
 return output.exports as T;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
type Driver={armOffline(c:unknown):Promise<any>;syncOffline(c:unknown,options?:{manual?:boolean;rearm?:boolean}):Promise<any>;beforeOnlinePunch(c:unknown):Promise<any>;
 afterOnlinePunch(c:unknown):Promise<any>;captureOfflinePunch(c:unknown,requestId:string):Promise<any>;offlineClaims(c:unknown):Promise<any[]>;removeUndeliverable(c:unknown,requestId:string):Promise<any>;
 subscribeOfflineForeground(run:()=>void):()=>void};
type Receipt=Record<string,unknown>;

/** Synthetic server: exact recovery by request id, strict chain order, auto-close after the last permit, exact close retry. */
function makeServer(permits:number){
 const pair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(pair.privateKey);
 const issuer={...identity,validFrom:issuedAt-1,validUntil:issuedAt+86400000,revoked:false};
 type Stream={raw:string;context:OfflineClockContextData;next:number;closed:null|{requestId:string;consumedThrough:number}};
 const streams=new Map<string,Stream>(),receipts=new Map<string,Receipt>(),calls:{op:string;body:string}[]=[];
 const s={issuer,streams,receipts,calls,outcomes:new Map<string,'accepted'|'needs_review'|'refused'>(),issueAnswer:null as Answer|null,
  uploadScript:[] as Array<(signed:OfflineClockSignedClaim,entry:{digest:string})=>unknown>,closeScript:[] as Array<(request:{contextId:string;closeRequestId:string;consumedThrough:number})=>unknown>,
  caps:{outcome:'offline',enabled:true,apiOrigin,companyId:id(5),issuers:[issuer],windowMs:86400000,permitCount:permits} as Record<string,unknown>,
  stream:(contextId:string)=>[...streams.values()].find(value=>value.context.id===contextId),
  issue(binding:OfflineClockContextBinding){
   calls.push({op:'context',body:JSON.stringify(binding.request)});if(s.issueAnswer)throw new ServerAnswer(s.issueAnswer);
   const existing=streams.get(binding.request.requestId);if(existing)return existing.raw;
   const context:OfflineClockContextData={version:1,purpose:'attendance.clock.offline.context',issuer:{algorithm:'ed25519',keyId:identity.keyId},id:randomUUID(),requestId:binding.request.requestId,
    requestNonce:binding.request.requestNonce,scope:binding.scope,target:binding.target,issuedAt,expiresAt:issuedAt+3600000,
    policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:86400000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},sites:[],
    attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},
    permits:Array.from({length:permits},(_,index)=>({id:randomUUID(),ordinal:index+1,nonce:randomBytes(32).toString('base64url')}))};
   const raw=signOfflineClockContext(context,pair.privateKey);streams.set(binding.request.requestId,{raw,context,next:1,closed:null});return raw;
  },
  upload(signed:OfflineClockSignedClaim,entry:{digest:string}){
   calls.push({op:'claim',body:JSON.stringify(signed)});const scripted=s.uploadScript.shift();if(scripted)return scripted(signed,entry);
   const c=signed.claim,prior=receipts.get(c.command.requestId);if(prior)return {outcome:'processed',receipt:prior};
   const stream=s.stream(c.context.id);if(!stream||stream.closed)return {outcome:'refused',code:'context_closed'};
   if(c.chain.sequence!==stream.next)return {outcome:'refused',code:'chain_conflict'};
   const outcome=s.outcomes.get(c.command.requestId)??'accepted';
   const receipt={version:1,purpose:'attendance.clock.offline.receipt',id:randomUUID(),contextId:c.context.id,requestId:c.command.requestId,sequence:c.chain.sequence,digest:entry.digest,outcome,
    reason:outcome==='accepted'?'clock_accepted':outcome==='needs_review'?'outside_geofence':'offline_disabled',receivedAt:c.time.claimedAt+5000,effectiveMinimum:c.time.claimedAt,
    effectiveMaximum:c.time.claimedAt+5000,effectiveAt:outcome==='accepted'?c.time.claimedAt:null,captureId:outcome==='accepted'?randomUUID():null,
    photo:c.command.photo?{sha256:c.command.photo.sha256,retainedUntil:c.time.claimedAt+2592000000}:null};
   receipts.set(c.command.requestId,receipt);stream.next+=1;
   if(stream.next>stream.context.permits.length)stream.closed={requestId:c.command.requestId,consumedThrough:stream.context.permits.length};
   return {outcome:'processed',receipt};
  },
  close(request:{contextId:string;closeRequestId:string;consumedThrough:number}){
   calls.push({op:'close',body:JSON.stringify(request)});const scripted=s.closeScript.shift();if(scripted)return scripted(request);
   const stream=s.stream(request.contextId);if(!stream)return {outcome:'refused',code:'context_unavailable'};
   const closed={outcome:'closed',contextId:request.contextId,reason:'retired',closeRequestId:request.closeRequestId,consumedThrough:request.consumedThrough,closedAt:issuedAt+60000};
   if(stream.closed)return stream.closed.requestId===request.closeRequestId&&stream.closed.consumedThrough===request.consumedThrough?closed:{outcome:'refused',code:'context_closed'};
   if(request.consumedThrough<stream.next-1)return {outcome:'refused',code:'cursor_mismatch'};
   if(request.consumedThrough>stream.next-1)return {outcome:'refused',code:'claims_pending'};
   stream.closed={requestId:request.closeRequestId,consumedThrough:request.consumedThrough};return closed;
  },
 };
 return s;
}
function world(options:{platform?:'ios'|'android';permits?:number;build?:boolean}={}){
 const platform=options.platform??'ios',server=makeServer(options.permits??3),store=new Map<string,SignedClockSnapshot>();
 const bytes=Buffer.from('synthetic photo bytes'),image={sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mimeType:'image/jpeg' as const};
 const proof=Buffer.from('opaque unverified proof').toString('base64');
 const net={offline:false};let counter=100;
 const snap=()=>({localOnly:true as const,runtimeId:id(12),source:platform==='ios'?'ios_continuous' as const:'android_elapsed_realtime' as const,elapsedBeforeNs:String(counter+=10),elapsedAfterNs:String(counter+1),wallTimeMs:issuedAt,bootId:platform==='ios'?null:'1'});
 const anchor={writeOfflineAnchor:vi.fn(async()=>{}),clearOfflineAnchor:vi.fn(async()=>{})};
 const appState={currentState:'active',addEventListener:vi.fn((_event:string,_listener:(state:string)=>void)=>({remove:vi.fn()}))};
 const driver=compile<Driver>('mobile/lib/offline-sync.ts',{'react-native':{AppState:appState},'expo-crypto':{getRandomBytes:(n:number)=>Uint8Array.from(randomBytes(n)),randomUUID},
  './auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./config':{config:{apiUrl:apiOrigin},offlineClockingBuild:options.build??true},'./errors':errors,
  './signed-clock-journal':journalModule,'./offline-clock-ports':{OfflineServerAnswer:ServerAnswer},'./offline-sync-hash':hashModule,'./offline-anchor':anchor});
 const offline=<T,>(run:()=>T)=>{if(net.offline)throw new errors.NetworkUnavailableError();return run();};
 function account(actorId=id(6)){
  const scope={namespace:'company',apiOrigin,actorId,appInstallationId:id(8)},storeKey=JSON.stringify(scope);
  const key={platform,apiOrigin,actorId,appInstallationId:id(8),installationId:id(3),tenantId:id(4),keyId:id(9),appId:platform==='ios'?'ABCDEFGHIJ.ai.hr':'ai.hr',
   nativeReference:platform==='ios'?Buffer.alloc(32,7).toString('base64'):'aihr_'+'a'.repeat(64)};
  const capability={version:1,platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:platform==='ios'?'apple_app_attest':'android_keystore'};
  type Offline=NonNullable<SignedClockPorts['offline']>;
  const sync={upload:vi.fn<NonNullable<Offline['sync']>['upload']>(async(signed,entry)=>offline(()=>server.upload(signed,entry))),
   close:vi.fn<NonNullable<Offline['sync']>['close']>(async request=>offline(()=>server.close(request))),deletePhoto:vi.fn<NonNullable<Offline['sync']>['deletePhoto']>(async()=>{})};
  const ports:SignedClockPorts={assertCurrent(){},read:vi.fn(async()=>store.get(storeKey)??null),commit:vi.fn(async value=>{store.set(storeKey,structuredClone(value));}),
   base:vi.fn<SignedClockPorts['base']>(async(_employment,requestId)=>({digest:'a'.repeat(64),command:{requestId,action:'in',lat:3,lng:101,accuracy:5,sampledAt:issuedAt},photo:image,source:{provider:null,mock:false,simulated:null,accessory:null}})),
   key:vi.fn(async()=>({key,capability})) as SignedClockPorts['key'],
   capabilities:vi.fn(async()=>({outcome:'capabilities',protocol:2,platform,commandProtocol:platform==='ios'?1:2,features:platform==='ios'?['online_clock_assertion']:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:platform==='ios'?null:'123456789'})),
   begin:vi.fn(async()=>({})),sign:vi.fn(async()=>({status:'unavailable' as const,reason:'unavailable' as const})),play:vi.fn(async()=>({status:'unavailable' as const,reason:'unavailable' as const})),
   complete:vi.fn(async()=>({})),receipt:vi.fn(async()=>({})),abandon:vi.fn(async()=>({})),resolveBase:vi.fn(async()=>{}),
   offline:{snapshot:()=>({status:'evidence',evidence:snap(),verification:'not_verified'}),request:vi.fn(async binding=>offline(()=>server.issue(binding))),
    verify:vi.fn(async(raw,expected)=>verifyOfflineClockContextSignature(raw,[server.issuer],expected.scope)),
    signing:{inspect:vi.fn(async()=>({status:'evidence' as const,evidence:{state:'absent' as const},verification:'not_verified' as const})),sign:vi.fn(async()=>({status:'evidence' as const,evidence:proof,verification:'not_verified' as const})),
     release:vi.fn(async()=>({status:'evidence' as const,evidence:null,verification:'not_verified' as const})),verifyPhoto:vi.fn(async()=>{})},
    capture:{capabilities:()=>({status:'evidence',evidence:NativeCapabilities.parse(capability),verification:'not_verified'}),digest:async canonical=>createHash('sha256').update(canonical).digest('hex'),
     retainPhoto:vi.fn(async requestId=>offlineClockPhotoReference(requestId)),releaseBase:vi.fn(async()=>{})},sync}};
  const journal=createSignedClockJournal(scope,ports);
  const c={platform,identity:{namespace:'company',apiOrigin,actorId,appInstallationId:id(8),employmentId,anchored:false},status:()=>journal.status(employmentId),key:async()=>({key,capability}),
   offline:{capabilities:vi.fn(async()=>offline(()=>server.caps)),target:async()=>platform==='ios'?{platform:'ios',appId:key.appId,environment:'production'}:{platform:'android',appId:key.appId,environment:null},
    snapshot:()=>({status:'evidence',evidence:snap(),verification:'not_verified'}),reserve:(binding:unknown)=>journal.reserveOffline(binding),prepare:(requestId:string)=>journal.prepareOffline(requestId),
    abandon:(requestId:string,code:string)=>journal.abandonReservation(requestId,code),capture:(input:unknown)=>journal.captureOffline(input),sign:(requestId:string,contextId:string)=>journal.signOffline(requestId,contextId),
    uploadNext:()=>journal.uploadNextOffline(),close:(closeRequestId:string)=>journal.closeOffline(closeRequestId),handback:(closeRequestId:string)=>journal.handbackUnusedContext(closeRequestId),
    removeUndeliverable:(requestId:string)=>journal.removeUndeliverable(requestId),claims:()=>journal.offlineClaims(employmentId)}};
  return {scope,key,ports,sync,journal,c,stored:()=>store.get(storeKey)??null};
 }
 const a=account();
 const ready=async()=>{expect(await driver.armOffline(a.c)).toMatchObject({state:'ready'});};
 const captureOffline=async(...requestIds:string[])=>{net.offline=true;for(const requestId of requestIds)expect(await driver.captureOfflinePunch(a.c,requestId)).toMatchObject({captured:{status:'captured'},proof:{status:'proof_ready'}});net.offline=false;};
 const exchange=()=>{const value=a.stored()?.offline;if(!value||value.phase==='context_requested')throw new Error('no ready exchange');return value;};
 const uploads=(requestId?:string)=>server.calls.filter(call=>call.op==='claim'&&(!requestId||(JSON.parse(call.body) as OfflineClockSignedClaim).claim.command.requestId===requestId));
 return {server,store,driver,anchor,appState,net,account,a,ready,captureOffline,exchange,uploads,snap,image};
}

describe('default off: no offline behaviour at all',()=>{
 it('build switch off: every driver entry point is inert, the online route is unchanged and nothing is stored or sent',async()=>{
  const w=world({build:false});
  expect(await w.driver.armOffline(w.a.c)).toEqual({state:'off',reason:'build'});expect(await w.driver.syncOffline(w.a.c,{manual:true})).toEqual({state:'off',reason:'build'});
  expect(await w.driver.beforeOnlinePunch(w.a.c)).toEqual({route:'online'});expect(await w.driver.afterOnlinePunch(w.a.c)).toEqual({state:'off',reason:'build'});
  expect(await w.driver.offlineClaims(w.a.c)).toEqual([]);await expect(w.driver.captureOfflinePunch(w.a.c,id(20))).rejects.toBeInstanceOf(errors.UnavailableError);
  w.driver.subscribeOfflineForeground(()=>{});expect(w.appState.addEventListener).not.toHaveBeenCalled();
  expect(w.a.c.offline.capabilities).not.toHaveBeenCalled();expect(w.server.calls).toEqual([]);expect(w.store.size).toBe(0);expect(w.anchor.writeOfflineAnchor).not.toHaveBeenCalled();
  // Online clocking proceeds exactly as today.
  expect(await w.a.journal.start(employmentId,id(40))).toMatchObject({status:'pending',phase:'intent'});
 });
 it('a controller without offline ports (switch off in the assembly) is online-only even with the driver switch on',async()=>{
  const w=world(),c={...w.a.c,offline:null};
  expect(await w.driver.armOffline(c)).toEqual({state:'off',reason:'build'});expect(await w.driver.beforeOnlinePunch(c)).toEqual({route:'online'});expect(w.store.size).toBe(0);
 });
 it.each([{outcome:'unavailable',code:'not_configured'},{outcome:'refused',code:'offline_disabled'}])('capabilities $code: no arming, no reservation and the online route unchanged',async caps=>{
  const w=world();w.server.caps=caps;
  expect(await w.driver.armOffline(w.a.c)).toEqual({state:'off',reason:'unavailable',code:caps.code});
  expect(w.store.size).toBe(0);expect(w.server.calls).toEqual([]);expect(w.anchor.writeOfflineAnchor).not.toHaveBeenCalled();
  expect(await w.driver.beforeOnlinePunch(w.a.c)).toEqual({route:'online'});expect(await w.a.journal.start(employmentId,id(40))).toMatchObject({status:'pending'});
 });
 it('drain (enabled:false) and a foreign apiOrigin never arm',async()=>{
  const w=world();w.server.caps={...w.server.caps,enabled:false};expect(await w.driver.armOffline(w.a.c)).toEqual({state:'off',reason:'draining'});
  w.server.caps={...w.server.caps,enabled:true,apiOrigin:'https://other.example.com'};expect(await w.driver.armOffline(w.a.c)).toEqual({state:'off',reason:'origin_mismatch'});
  expect(w.store.size).toBe(0);expect(w.server.calls).toEqual([]);
 });
});

describe('arming: identity anchor, reservation and E1 refusals',()=>{
 it('saves the device-only anchor before the reservation and binds the capabilities companyId into the scope',async()=>{
  const w=world();await w.ready();
  expect(w.anchor.writeOfflineAnchor).toHaveBeenCalledWith({version:1,namespace:'company',apiOrigin,actorId:id(6),employmentId,companyId:id(5),platform:'ios'},expect.any(Function));
  expect(w.anchor.writeOfflineAnchor.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(w.a.ports.commit).mock.invocationCallOrder[0]);
  expect(w.exchange().binding.scope).toMatchObject({companyId:id(5),actorId:id(6),employmentId});expect(w.server.calls.map(call=>call.op)).toEqual(['context']);
  // A ready context blocks online start until it is handed back (decision 1).
  await expect(w.a.journal.start(employmentId,id(40))).rejects.toBeInstanceOf(SignedClockConflict);
 });
 it.each([...OFFLINE_NOTHING_ISSUED])('E1 refusal %s proves nothing was issued: the reservation and anchor are dropped',async code=>{
  const w=world();w.server.issueAnswer={outcome:'refused',code};
  expect(await w.driver.armOffline(w.a.c)).toEqual({state:'off',reason:'refused',code});
  expect(w.a.stored()?.offline).toBeNull();expect(w.anchor.clearOfflineAnchor).toHaveBeenCalledOnce();
  expect(await w.a.journal.start(employmentId,id(40))).toMatchObject({status:'pending'});
 });
 it.each([{outcome:'refused',code:'binding_conflict'},{outcome:'refused',code:'time_unavailable'},{outcome:'unavailable',code:'configuration_unavailable'}] as Answer[])('E1 answer $code keeps the reservation for an exact retry',async answer=>{
  const w=world();w.server.issueAnswer=answer;
  expect(await w.driver.armOffline(w.a.c)).toMatchObject({state:'waiting'});
  const reserved=w.a.stored()!.offline!;expect(reserved.phase).toBe('context_requested');
  w.server.issueAnswer=null;expect(await w.driver.armOffline(w.a.c)).toMatchObject({state:'ready'});
  const requests=w.server.calls.filter(call=>call.op==='context').map(call=>call.body);expect(new Set(requests).size).toBe(1);
  expect(w.exchange().requestStarted).toEqual(reserved.requestStarted);
 });
 it('refuses to abandon an issued or foreign reservation',async()=>{
  const w=world();await w.ready();
  await expect(w.a.journal.abandonReservation(w.exchange().binding.request.requestId,'offline_disabled')).rejects.toBeInstanceOf(SignedClockConflict);
  const v=world();v.server.issueAnswer={outcome:'unavailable',code:'configuration_unavailable'};await v.driver.armOffline(v.a.c);
  const requestId=v.a.stored()!.offline!.binding.request.requestId;
  await expect(v.a.journal.abandonReservation(requestId,'binding_conflict')).rejects.toBeInstanceOf(SignedClockConflict);
  await expect(v.a.journal.abandonReservation(id(99),'offline_disabled')).rejects.toBeInstanceOf(SignedClockConflict);
 });
});

describe('the punch route: handback before online, offline only without connectivity, upload first on reconnect',()=>{
 it('hands back a zero-claim context (consumedThrough 0) before an online punch, then re-arms afterwards',async()=>{
  const w=world();await w.ready();const contextId=w.exchange().rawContext;
  expect(await w.driver.beforeOnlinePunch(w.a.c)).toEqual({route:'online'});
  const close=w.server.calls.filter(call=>call.op==='close').map(call=>JSON.parse(call.body));expect(close).toEqual([expect.objectContaining({consumedThrough:0})]);
  expect(w.a.stored()!.offline).toBeNull();expect(w.anchor.clearOfflineAnchor).toHaveBeenCalled();
  expect(await w.a.journal.start(employmentId,id(40))).toMatchObject({status:'pending'});
  // Re-arming waits for the online pending work; once it settles a new context is prepared.
  expect(await w.driver.afterOnlinePunch(w.a.c)).toEqual({state:'blocked',reason:'pending_online'});
  w.store.set(JSON.stringify(w.a.scope),{...w.a.stored()!,pending:null});
  expect(await w.driver.afterOnlinePunch(w.a.c)).toMatchObject({state:'ready'});expect(w.exchange().rawContext).not.toBe(contextId);
 });
 it('chooses offline only when the probe gets no HTTP response, and captures locally with no request',async()=>{
  const w=world();await w.ready();const before=w.server.calls.length;w.net.offline=true;
  const route=await w.driver.beforeOnlinePunch(w.a.c);expect(route).toMatchObject({route:'offline'});
  expect(await w.driver.captureOfflinePunch(w.a.c,id(20))).toMatchObject({captured:{status:'captured',sequence:1},proof:{status:'proof_ready'}});
  expect(w.server.calls.length).toBe(before);expect(await w.driver.offlineClaims(w.a.c)).toEqual([expect.objectContaining({requestId:id(20),state:'waiting',sequence:1,action:'in'})]);
  // An outage (5xx) is never "offline": the probe error propagates and no capture route is offered.
  w.net.offline=false;vi.mocked(w.a.c.offline.capabilities).mockRejectedValueOnce(new errors.UnavailableError());
  await expect(w.driver.beforeOnlinePunch(w.a.c)).rejects.toBeInstanceOf(errors.UnavailableError);
 });
 it('on reconnect uploads every saved claim first, strictly in order, closes, and only then allows online clocking',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20),id(21));
  await expect(w.a.journal.start(employmentId,id(40))).rejects.toBeInstanceOf(SignedClockConflict);
  expect(await w.driver.beforeOnlinePunch(w.a.c)).toEqual({route:'online'});
  expect(w.uploads().map(call=>(JSON.parse(call.body) as OfflineClockSignedClaim).claim.chain.sequence)).toEqual([1,2]);
  expect(w.server.calls.filter(call=>call.op==='close').map(call=>JSON.parse(call.body).consumedThrough)).toEqual([2]);
  expect(w.a.sync.deletePhoto.mock.calls.map(call=>call[0])).toEqual(expect.arrayContaining([id(20),id(21)]));
  expect(w.a.stored()!.offline).toBeNull();expect(w.a.stored()!.recent).toHaveLength(2);
  expect(await w.driver.offlineClaims(w.a.c)).toEqual([expect.objectContaining({requestId:id(20),state:'recorded',effectiveAt:expect.any(Number)}),expect.objectContaining({requestId:id(21),state:'recorded'})]);
  expect(await w.a.journal.start(employmentId,id(40))).toMatchObject({status:'pending'});
 });
 it('after the last permit\'s receipt the server already closed the context: cleared locally without a close request',async()=>{
  const w=world({permits:2});await w.ready();await w.captureOffline(id(20),id(21));
  expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'ready'});
  expect(w.server.calls.filter(call=>call.op==='close')).toEqual([]);expect(w.a.stored()!.recent).toHaveLength(2);
 });
 it.each(['ios','android'] as const)('%s shows only the server outcome per claim',async platform=>{
  const w=world({platform,permits:4});await w.ready();await w.captureOffline(id(20),id(21),id(22));
  w.server.outcomes.set(id(21),'needs_review');w.server.outcomes.set(id(22),'refused');
  await w.driver.syncOffline(w.a.c,{manual:true,rearm:false});
  expect(await w.driver.offlineClaims(w.a.c)).toEqual([
   expect.objectContaining({requestId:id(20),state:'recorded',effectiveAt:expect.any(Number)}),
   expect.objectContaining({requestId:id(21),state:'held',reason:'outside_geofence'}),
   expect.objectContaining({requestId:id(22),state:'not_recorded',reason:'offline_disabled'})]);
 });
});

describe('claim upload response mapping (journal)',()=>{
 async function one(platform:'ios'|'android'='ios'){const w=world({platform});await w.ready();await w.captureOffline(id(20));return w;}
 it.each(['key_unavailable','context_closed','context_unavailable','binding_conflict','invalid_proof','attachment_mismatch','invalid_claim'])('%s is undeliverable and never retried automatically',async code=>{
  const w=await one();w.server.uploadScript.push(()=>({outcome:'refused',code}));
  expect(await w.a.journal.uploadNextOffline()).toEqual({status:'undeliverable',requestId:id(20),reason:code});
  expect(w.exchange().claims[0]).toMatchObject({undeliverable:{reason:code,dismissed:false},receipt:null});
  expect(await w.a.journal.uploadNextOffline()).toEqual({status:'undeliverable',requestId:id(20),reason:code});expect(w.uploads()).toHaveLength(1);
  expect(await w.driver.offlineClaims(w.a.c)).toEqual([expect.objectContaining({requestId:id(20),state:'undeliverable',reason:code})]);
 });
 it('HTTP 400 is undeliverable (bad_request)',async()=>{
  const w=await one();w.a.sync.upload.mockRejectedValueOnce(new errors.RequestRejectedError(400));
  expect(await w.a.journal.uploadNextOffline()).toEqual({status:'undeliverable',requestId:id(20),reason:'bad_request'});
 });
 const queued:Array<[Answer,string]>=[
  [{outcome:'unavailable',code:'not_configured'},'backoff'],[{outcome:'unavailable',code:'configuration_unavailable'},'backoff'],[{outcome:'unavailable',code:'module_unavailable'},'backoff'],
  [{outcome:'unavailable',code:'draining'},'backoff'],[{outcome:'unavailable',code:'proof_unavailable',integrityReason:'provider_unavailable'},'backoff'],
  [{outcome:'refused',code:'chain_conflict'},'backoff'],[{outcome:'refused',code:'scope_unavailable'},'slow'],[{outcome:'refused',code:'time_unavailable'},'slow'],
  ...['stale_token','request_mismatch','invalid_token','token_missing'].map((reason):[Answer,string]=>[{outcome:'refused',code:'sync_integrity',integrityReason:reason},'fresh_token']),
  ...['device_integrity','app_mismatch','version_mismatch','unrecognized_app','unlicensed_app'].map((reason):[Answer,string]=>[{outcome:'refused',code:'sync_integrity',integrityReason:reason},'slow']),
 ];
 it.each(queued)('%o keeps the claim queued (%s)',async(answer,pace)=>{
  const w=await one('android');const before=structuredClone(w.a.stored());w.server.uploadScript.push(()=>answer);
  expect(await w.a.journal.uploadNextOffline()).toMatchObject({status:'retry',requestId:id(20),code:answer.code,pace});expect(w.a.stored()).toEqual(before);
 });
 it('refuses a receipt that is not this claim\'s exact receipt and saves nothing',async()=>{
  const w=await one();const before=structuredClone(w.a.stored());
  for(const change of [{digest:'c'.repeat(64)},{sequence:2},{requestId:id(99)},{contextId:id(99)},{photo:null}]){
   w.server.uploadScript.push((signed,entry)=>{const fresh=makeServer(3);fresh.streams.set('x',{...w.server.stream(signed.claim.context.id)!,next:1,closed:null});
    const result=fresh.upload(signed,entry) as {receipt:Receipt};return {outcome:'processed',receipt:{...result.receipt,...change}};});
   await expect(w.a.journal.uploadNextOffline()).rejects.toBeInstanceOf(SignedClockConflict);expect(w.a.stored()).toEqual(before);
  }
 });
 it('never re-signs: a retry after a lost response resends the identical claim JSON and receives the original receipt',async()=>{
  const w=await one();
  w.a.sync.upload.mockImplementationOnce(async(signed,entry)=>{w.server.upload(signed,entry);throw new errors.NetworkUnavailableError();});
  await expect(w.a.journal.uploadNextOffline()).rejects.toBeInstanceOf(errors.NetworkUnavailableError);expect(w.exchange().claims[0].receipt).toBeNull();
  expect(await w.a.journal.uploadNextOffline()).toMatchObject({status:'processed',requestId:id(20)});
  const bodies=w.uploads().map(call=>call.body);expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
  expect(w.server.receipts.size).toBe(1);expect(w.a.ports.offline!.signing!.sign).toHaveBeenCalledOnce();
 });
 it('uploads only a durable, natively released proof, one claim per call, lowest first',async()=>{
  const w=world();await w.ready();w.net.offline=true;
  const snapshot=w.a.c.offline.snapshot();if(snapshot.status!=='evidence')throw new Error('no snapshot');
  await w.a.journal.captureOffline({requestId:id(20),expectedContextId:JSON.parse(w.exchange().rawContext).context.id,claimedAt:issuedAt,eventSnapshot:snapshot.evidence});w.net.offline=false;
  expect(await w.a.journal.uploadNextOffline()).toEqual({status:'not_signed',requestId:id(20)});expect(w.uploads()).toEqual([]);
 });
});

describe('the driver: retries, backoff and budget (foreground-only)',()=>{
 it('retries a stale Play token once at once with a fresh token, then backs off',async()=>{
  const w=world({platform:'android'});await w.ready();await w.captureOffline(id(20));
  w.server.uploadScript.push(()=>({outcome:'refused',code:'sync_integrity',integrityReason:'stale_token'}));
  expect(await w.driver.syncOffline(w.a.c,{manual:true,rearm:false})).toEqual({state:'idle'});expect(w.uploads()).toHaveLength(2);
  const v=world({platform:'android'});await v.ready();await v.captureOffline(id(20));
  v.server.uploadScript.push(()=>({outcome:'refused',code:'sync_integrity',integrityReason:'stale_token'}),()=>({outcome:'refused',code:'sync_integrity',integrityReason:'stale_token'}));
  expect(await v.driver.syncOffline(v.a.c,{manual:true})).toMatchObject({state:'waiting',code:'sync_integrity'});expect(v.uploads()).toHaveLength(2);
 });
 it('keeps the queue on every transport failure, honours retry-after, and propagates 401 without touching the queue',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20));const before=structuredClone(w.a.stored());
  w.a.sync.upload.mockRejectedValueOnce(new errors.NetworkUnavailableError());expect(await w.driver.syncOffline(w.a.c,{manual:true})).toEqual({state:'offline'});
  w.a.sync.upload.mockRejectedValueOnce(new errors.UnavailableError(undefined,120));const throttled=await w.driver.syncOffline(w.a.c,{manual:true});
  expect(throttled.state).toBe('waiting');expect(throttled.retryAt-Date.now()).toBeGreaterThan(119000);
  expect(await w.driver.syncOffline(w.a.c)).toEqual({state:'waiting',retryAt:throttled.retryAt});
  w.a.sync.upload.mockRejectedValueOnce(new errors.UnavailableError(undefined,undefined,'support'));expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'waiting'});
  w.a.sync.upload.mockRejectedValueOnce(new errors.SignInRequiredError());await expect(w.driver.syncOffline(w.a.c,{manual:true})).rejects.toBeInstanceOf(errors.SignInRequiredError);
  expect(w.a.stored()).toEqual(before);
  expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'ready'});expect(w.server.receipts.size).toBe(1);
 });
 it('spends at most 64 upload attempts per rolling hour',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20));
  w.a.sync.upload.mockImplementation(async()=>({outcome:'unavailable',code:'proof_unavailable'}));
  for(let attempt=0;attempt<64;attempt++)expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'waiting'});
  expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'waiting',code:'budget'});expect(w.a.sync.upload).toHaveBeenCalledTimes(64);
 });
 it('retries on foreground only through the subscription it returns',async()=>{
  const w=world(),run=vi.fn(),stop=w.driver.subscribeOfflineForeground(run);
  const listener=w.appState.addEventListener.mock.calls[0][1];listener('background');expect(run).not.toHaveBeenCalled();listener('active');expect(run).toHaveBeenCalledOnce();
  stop();expect(w.appState.addEventListener.mock.results[0].value.remove).toHaveBeenCalledOnce();
 });
});

describe('undeliverable claims and the employee\'s removal (decision 2)',()=>{
 it('the first undeliverable claim stops the stream; removal with confirmation clears them, then the context closes and re-arms',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20),id(21));
  w.server.uploadScript.push(()=>({outcome:'refused',code:'invalid_proof'}));
  expect(await w.driver.syncOffline(w.a.c,{manual:true})).toEqual({state:'blocked',reason:'needs_attention',code:'invalid_proof'});
  expect(w.uploads()).toHaveLength(1);expect(await w.driver.beforeOnlinePunch(w.a.c)).toMatchObject({route:'blocked'});
  expect(await w.driver.offlineClaims(w.a.c)).toEqual([expect.objectContaining({requestId:id(20),state:'undeliverable',reason:'invalid_proof'}),expect.objectContaining({requestId:id(21),state:'undeliverable',reason:'earlier_undeliverable'})]);
  await w.driver.removeUndeliverable(w.a.c,id(21));expect(w.a.sync.deletePhoto).not.toHaveBeenCalled();
  expect(await w.driver.offlineClaims(w.a.c)).toEqual([expect.objectContaining({requestId:id(20),state:'undeliverable'})]);
  expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'blocked',reason:'needs_attention'});
  await w.driver.removeUndeliverable(w.a.c,id(20));expect(await w.driver.offlineClaims(w.a.c)).toEqual([]);
  expect(await w.driver.syncOffline(w.a.c,{manual:true})).toMatchObject({state:'ready'});
  expect(w.server.calls.filter(call=>call.op==='close').map(call=>JSON.parse(call.body).consumedThrough)).toEqual([0]);expect(w.uploads()).toHaveLength(1);
  // Photos of removed claims end with the exchange.
  expect(new Set(w.a.sync.deletePhoto.mock.calls.map(call=>call[0]))).toEqual(new Set([id(20),id(21)]));
 });
 it('refuses removing a deliverable or received claim',async()=>{
  const w=world({permits:4});await w.ready();await w.captureOffline(id(20),id(21));
  await expect(w.driver.removeUndeliverable(w.a.c,id(20))).rejects.toBeInstanceOf(SignedClockConflict);
  await w.a.journal.uploadNextOffline();await expect(w.driver.removeUndeliverable(w.a.c,id(20))).rejects.toBeInstanceOf(SignedClockConflict);
 });
});

describe('close answers (journal)',()=>{
 async function received(){const w=world();await w.ready();await w.captureOffline(id(20));await w.a.journal.uploadNextOffline();return w;}
 it('saves the close request before its POST and resends it identically after a lost answer',async()=>{
  const w=await received();
  w.a.sync.close.mockImplementationOnce(async request=>{expect(w.exchange()).toMatchObject({phase:'closing',close:{requestId:request.closeRequestId,consumedThrough:1}});throw new errors.NetworkUnavailableError();});
  await expect(w.a.journal.closeOffline(randomUUID())).rejects.toBeInstanceOf(errors.NetworkUnavailableError);
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status:'closed'});
  const sent=w.a.sync.close.mock.calls.map(call=>JSON.stringify(call[0]));expect(sent).toHaveLength(2);expect(sent[1]).toBe(sent[0]);
 });
 it.each([['claims_pending','held'],['binding_conflict','held']] as const)('%s holds the closing exchange',async(code,status)=>{
  const w=await received();w.server.closeScript.push(()=>({outcome:'refused',code}));
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status,reason:code});expect(w.exchange().phase).toBe('closing');
  await expect(w.a.journal.start(employmentId,id(40))).rejects.toBeInstanceOf(SignedClockConflict);
 });
 it('unavailable keeps the closing exchange for an identical retry',async()=>{
  const w=await received();w.server.closeScript.push(()=>({outcome:'unavailable',code:'configuration_unavailable'}));
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status:'retry',code:'configuration_unavailable'});expect(w.exchange().phase).toBe('closing');
 });
 it.each(['context_closed','key_unavailable','context_unavailable'])('%s clears locally once every local claim has its receipt',async code=>{
  const w=await received();w.server.closeScript.push(()=>({outcome:'refused',code}));
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status:'closed'});expect(w.a.stored()!.offline).toBeNull();
 });
 it('cursor_mismatch reopens, requeues the unreceived claim for an exact re-upload, then closes again',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20));
  // The server consumed the claim but this phone lost the receipt and was told it was undeliverable (synthetic).
  w.a.sync.upload.mockImplementationOnce(async(signed,entry)=>{w.server.upload(signed,entry);return {outcome:'refused',code:'invalid_proof'};});
  await w.a.journal.uploadNextOffline();await w.a.journal.removeUndeliverable(id(20));
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status:'reopened'});
  expect(w.exchange()).toMatchObject({phase:'context_ready',claims:[{undeliverable:null,receipt:null}]});
  expect(await w.a.journal.uploadNextOffline()).toMatchObject({status:'processed',requestId:id(20)});
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status:'closed'});
 });
 it('never closes while a deliverable claim lacks its receipt',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20));
  expect(await w.a.journal.closeOffline(randomUUID())).toEqual({status:'held',reason:'claims'});expect(await w.a.journal.handbackUnusedContext(randomUUID())).toEqual({status:'held',reason:'claims'});
  expect(w.server.calls.filter(call=>call.op==='close')).toEqual([]);
 });
});

describe('restart safety: a crash at every commit point converges with identical requests',()=>{
 for(const mode of ['lost_acknowledgement','failed_write'] as const)it(mode,async()=>{
  const baseline=world();await baseline.ready();await baseline.captureOffline(id(20),id(21));
  const setup=vi.mocked(baseline.a.ports.commit).mock.calls.length;
  expect(await baseline.driver.syncOffline(baseline.a.c,{manual:true})).toMatchObject({state:'ready'});
  const total=vi.mocked(baseline.a.ports.commit).mock.calls.length-setup;expect(total).toBeGreaterThanOrEqual(8);
  for(let point=1;point<=total;point++){
   const w=world();await w.ready();await w.captureOffline(id(20),id(21));
   const commit=vi.mocked(w.a.ports.commit),original=commit.getMockImplementation()!;let seen=0;
   commit.mockImplementation(async value=>{
    seen+=1;if(seen!==point)return original(value);
    if(mode==='lost_acknowledgement')await original(value);throw new Error('crash at commit '+point);
   });
   await w.driver.syncOffline(w.a.c,{manual:true}).catch(()=>undefined);
   commit.mockImplementation(original);
   expect(await w.driver.syncOffline(w.a.c,{manual:true}),'commit '+point).toMatchObject({state:'ready'});
   expect(w.server.receipts.size,'commit '+point).toBe(2);
   for(const requestId of [id(20),id(21)]){const bodies=w.uploads(requestId).map(call=>call.body);expect(new Set(bodies).size,'commit '+point).toBe(1);}
   expect(new Set(w.server.calls.filter(call=>call.op==='close').map(call=>call.body)).size,'commit '+point).toBe(1);
   expect(w.a.stored()!.recent?.map(item=>item.receipt.requestId),'commit '+point).toEqual([id(20),id(21)]);
   expect(new Set(w.a.sync.deletePhoto.mock.calls.map(call=>call[0])),'commit '+point).toEqual(new Set([id(20),id(21)]));
  }
 });
});

describe('expiry (decision 7)',()=>{
 it('blocks capture once the proven elapsed lower bound reaches the window; unknown continuity is allowed',async()=>{
  const w=world();await w.ready();const exchange=w.exchange(),contextId=JSON.parse(exchange.rawContext).context.id;
  const start=BigInt(exchange.responseReceived.elapsedAfterNs)+BigInt(3600000)*BigInt(1000000);
  const expired={...exchange.responseReceived,elapsedBeforeNs:String(start),elapsedAfterNs:String(start+BigInt(1))};
  await expect(w.a.journal.captureOffline({requestId:id(20),expectedContextId:contextId,claimedAt:issuedAt,eventSnapshot:expired})).rejects.toMatchObject({reason:'expired'});
  expect(w.a.ports.base).not.toHaveBeenCalled();expect(w.exchange().claims).toEqual([]);
  const restarted={...expired,runtimeId:id(99)};
  expect(await w.a.journal.captureOffline({requestId:id(20),expectedContextId:contextId,claimedAt:issuedAt,eventSnapshot:restarted})).toMatchObject({status:'captured'});
  expect(w.exchange().claims[0].claim.time.elapsed).toEqual({status:'unknown',reason:'continuity_unknown'});
 });
});

describe('sign-out and a different user (decision 3)',()=>{
 it('the queue stays sealed for its own account; another account on the device never sees or sends it',async()=>{
  const w=world();await w.ready();await w.captureOffline(id(20),id(21));const sealed=structuredClone(w.a.stored());
  const other=w.account(id(66));
  expect(await other.journal.offlineClaims(employmentId)).toEqual({exchange:null,claims:[]});expect(await w.driver.offlineClaims(other.c)).toEqual([]);
  expect(await other.journal.uploadNextOffline()).toEqual({status:'idle'});
  expect(await w.driver.syncOffline(other.c,{manual:true})).toMatchObject({state:'ready'});
  expect(w.uploads()).toEqual([]);expect(w.a.stored()).toEqual(sealed);
  // The same employee, back online, uploads them first.
  expect(await w.driver.beforeOnlinePunch(w.a.c)).toEqual({route:'online'});expect(w.uploads()).toHaveLength(2);
 });
});

describe('live offline ports (offline-clock-ports.ts)',()=>{
 class Form{entries:[string,unknown][]=[];append(name:string,value:unknown){this.entries.push([name,value]);}get(name:string){return this.entries.find(([key])=>key===name)?.[1];}}
 async function signedClaim(platform:'ios'|'android'){
  const w=world({platform});await w.ready();await w.captureOffline(id(20));const entry=w.exchange().claims[0];
  const signed=offlineClock.OfflineClockSignedClaim.parse({claim:entry.claim,proof:platform==='ios'?{platform,assertion:entry.proof}:{platform,signature:entry.proof}});
  return {signed,entry};
 }
 function ports(platform:'ios'|'android'){
  const apiPost=vi.fn(async(_path:string,_body:unknown,_params:unknown,_operation:unknown)=>({outcome:'processed'}));
  const apiGet=vi.fn(async(_path:string,_params:unknown):Promise<Record<string,unknown>>=>({outcome:'offline',enabled:true,apiOrigin,companyId:id(5),issuers:[],windowMs:86400000,permitCount:8}));
  const native={capabilities:vi.fn(()=>({status:'evidence',evidence:{version:1,platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:platform==='ios'?'apple_app_attest':'android_keystore'},verification:'not_verified'})),
   clockSnapshot:vi.fn(),preparePlayIntegrity:vi.fn(async(_project:string)=>({status:'evidence',evidence:null,verification:'not_verified'})),
   requestPlayIntegrity:vi.fn(async(_hash:string)=>({status:'evidence',evidence:'fresh-token',verification:'not_verified'}))};
  const registry={anchoredIdentity:vi.fn(),readIssuerRegistry:vi.fn(async()=>null),writeIssuerRegistry:vi.fn(async()=>{})};
  const module=compile<{createOfflineClockPorts:(deps:unknown)=>NonNullable<SignedClockPorts['offline']>;readOfflineCapabilities:(deps:unknown)=>Promise<unknown>}>('mobile/lib/offline-clock-ports.ts',{
   'expo-crypto':{CryptoDigestAlgorithm:{SHA256:'sha256'},CryptoEncoding:{HEX:'hex'},digest:async(_:string,bytes:Uint8Array)=>Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    digestStringAsync:async(_:string,value:string)=>createHash('sha256').update(value).digest('hex')},
   './api':{apiGet,apiPost},'../../lib/mobile-offline-contract':offlineContract,'../../lib/mobile-offline-clock':offlineClock,'./offline-context':{verifyNativeOfflineClockContext:vi.fn()},
   './offline-clock-signing':{createOfflineClockSigner:()=>({})},'./offline-anchor':registry,'./offline-sync-hash':hashModule,'./signed-clock-journal':journalModule},{FormData:Form});
  const photos={read:vi.fn(async()=>Uint8Array.from([1,2,3])),retain:vi.fn(),remove:vi.fn(async()=>{})};
  const deps={platform,employmentId,namespace:'company',apiOrigin,check:()=>{},operation:{assertCurrent(){}},isForeground:()=>true,native,photos,basePhoto:vi.fn(),resolveBase:vi.fn(),cloudProject:vi.fn(async()=>'123456789')};
  return {module,live:module.createOfflineClockPorts(deps),apiPost,apiGet,native,photos,registry,deps};
 }
 it('Android: a fresh payload-bound Play token per attempt, bound to the digest, the original signature and the running build',async()=>{
  const {signed,entry}=await signedClaim('android'),p=ports('android');
  await p.live.sync!.upload(signed,{requestId:id(20),digest:entry.digest});await p.live.sync!.upload(signed,{requestId:id(20),digest:entry.digest});
  const expected=offlineSyncRequestHash({claimDigest:entry.digest,signatureSha256:createHash('sha256').update(Buffer.from(entry.proof!,'base64')).digest('hex'),syncBuildVersion:'4'});
  expect(p.native.requestPlayIntegrity.mock.calls).toEqual([[expected],[expected]]);expect(p.native.preparePlayIntegrity).toHaveBeenCalledWith('123456789');
  const [path,body,params]=p.apiPost.mock.calls[0],form=body as Form;
  expect(path).toBe('v2/integrity/android/offline/claim');expect(params).toEqual({employmentId});
  expect(form.entries.map(([name])=>name)).toEqual(['claim','photo','playIntegrityToken','syncBuildVersion']);
  expect(form.get('claim')).toBe(JSON.stringify(signed));expect(form.get('playIntegrityToken')).toBe('fresh-token');expect(form.get('syncBuildVersion')).toBe('4');
  expect(await (form.get('photo') as {bytes:()=>Promise<Uint8Array>}).bytes()).toEqual(Uint8Array.from([1,2,3]));
  expect((p.apiPost.mock.calls[1][1] as Form).get('claim')).toBe(form.get('claim'));
 });
 it('iPhone: the claim\'s own assertion is the proof; no native call and no token at upload',async()=>{
  const {signed,entry}=await signedClaim('ios'),p=ports('ios');
  await p.live.sync!.upload(signed,{requestId:id(20),digest:entry.digest});
  expect(p.native.capabilities).not.toHaveBeenCalled();expect(p.native.preparePlayIntegrity).not.toHaveBeenCalled();expect(p.native.requestPlayIntegrity).not.toHaveBeenCalled();
  const form=p.apiPost.mock.calls[0][1] as Form;expect(form.entries.map(([name])=>name)).toEqual(['claim','photo']);
 });
 it('refuses a claim for another employment or platform before any network or native work',async()=>{
  const {signed,entry}=await signedClaim('ios'),p=ports('android');
  await expect(p.live.sync!.upload(signed,{requestId:id(20),digest:entry.digest})).rejects.toBeInstanceOf(SignedClockConflict);
  expect(p.apiPost).not.toHaveBeenCalled();expect(p.native.requestPlayIntegrity).not.toHaveBeenCalled();
 });
 it('close sends the exact JSON request; photo deletion goes to the guarded store; the issuer cache follows each capabilities read',async()=>{
  const p=ports('ios'),request={contextId:id(1),closeRequestId:id(2),consumedThrough:0};
  await p.live.sync!.close(request);expect(p.apiPost).toHaveBeenCalledWith('v2/integrity/ios/offline/context/close',request,{employmentId},expect.anything());
  await p.live.sync!.deletePhoto(id(20));expect(p.photos.remove).toHaveBeenCalledWith(id(20));
  await p.module.readOfflineCapabilities(p.deps);expect(p.registry.writeIssuerRegistry).toHaveBeenCalledWith({namespace:'company',apiOrigin,platform:'ios',issuers:[]},expect.any(Function));
  p.apiGet.mockResolvedValueOnce({outcome:'offline',enabled:true,apiOrigin:'https://other.example.com',companyId:id(5),issuers:[],windowMs:86400000,permitCount:8});
  p.apiGet.mockResolvedValueOnce({outcome:'unavailable',code:'not_configured'});
  await p.module.readOfflineCapabilities(p.deps);await p.module.readOfflineCapabilities(p.deps);expect(p.registry.writeIssuerRegistry).toHaveBeenCalledOnce();
  await expect(p.live.verify('{}',{} as OfflineClockContextBinding)).rejects.toMatchObject({reason:'configuration'});
 });
 it('a context request answered without issuing raises the server answer for the driver',async()=>{
  const p=ports('ios');p.apiPost.mockResolvedValueOnce({outcome:'refused',code:'online_pending'} as never);
  const binding={scope:{employmentId},request:{requestId:id(2),requestNonce:'A'.repeat(43),appInstallationId:id(8),keyId:id(9)}} as unknown as OfflineClockContextBinding;
  await expect(p.live.request(binding)).rejects.toMatchObject({answer:{outcome:'refused',code:'online_pending'}});
 });
});

describe('device-only identity anchor (offline-anchor.ts)',()=>{
 function anchorModule(build=true){
  const records=new Map<string,unknown>();
  const storage={readSealedDeviceRecord:vi.fn(async(name:string)=>records.get(name)??null),writeSealedDeviceRecord:vi.fn(async(name:string,value:unknown)=>{records.set(name,structuredClone(value));}),
   deleteSealedDeviceRecord:vi.fn((name:string)=>{records.delete(name);})};
  const module=compile<{readOfflineAnchor(check:()=>void):Promise<unknown>;writeOfflineAnchor(anchor:unknown,check:()=>void):Promise<void>;clearOfflineAnchor(expected:unknown,check:()=>void):Promise<void>;
   endOfflineAnchor():void;anchoredIdentity(error:unknown,expected:unknown,check:()=>void):Promise<unknown>;readIssuerRegistry(expected:unknown,check:()=>void):Promise<unknown>;writeIssuerRegistry(value:unknown,check:()=>void):Promise<void>}>(
   'mobile/lib/offline-anchor.ts',{zod:{z},'../../lib/mobile-key-enrollment':keyEnrollment,'../../lib/mobile-offline-context':offlineContext,'./config':{offlineClockingBuild:build},'./errors':errors,'./submission-native':storage});
  return {module,records,storage};
 }
 const anchor={version:1,namespace:'company',apiOrigin,actorId:id(6),employmentId,companyId:id(5),platform:'ios'};
 const expected={namespace:'company',apiOrigin,employmentId};
 it('opens offline only for a no-response failure on the same connection and employment',async()=>{
  const a=anchorModule();await a.module.writeOfflineAnchor(anchor,()=>{});
  expect(await a.module.anchoredIdentity(new errors.NetworkUnavailableError(),expected,()=>{})).toEqual(anchor);
  expect(await a.module.anchoredIdentity(new errors.UnavailableError(),expected,()=>{})).toBeNull();
  for(const change of [{namespace:'other'},{apiOrigin:'https://other.example.com'},{employmentId:id(99)}])expect(await a.module.anchoredIdentity(new errors.NetworkUnavailableError(),{...expected,...change},()=>{})).toBeNull();
 });
 it('logout ends the anchor, so the next account on this device can never open the previous queue offline',async()=>{
  const a=anchorModule();await a.module.writeOfflineAnchor(anchor,()=>{});a.module.endOfflineAnchor();
  expect(a.storage.deleteSealedDeviceRecord).toHaveBeenCalledWith('offline-anchor');
  expect(await a.module.anchoredIdentity(new errors.NetworkUnavailableError(),expected,()=>{})).toBeNull();
  expect(a.storage.deleteSealedDeviceRecord).not.toHaveBeenCalledWith('offline-issuers');
 });
 it('clears only its own actor\'s anchor; an unreadable record is absent; the switch off reads nothing',async()=>{
  const a=anchorModule();await a.module.writeOfflineAnchor(anchor,()=>{});
  await a.module.clearOfflineAnchor({namespace:'company',actorId:id(66)},()=>{});expect(await a.module.readOfflineAnchor(()=>{})).toEqual(anchor);
  await a.module.clearOfflineAnchor({namespace:'company',actorId:id(6)},()=>{});expect(await a.module.readOfflineAnchor(()=>{})).toBeNull();
  a.storage.readSealedDeviceRecord.mockRejectedValueOnce(new Error('tampered'));expect(await a.module.readOfflineAnchor(()=>{})).toBeNull();
  const off=anchorModule(false);off.records.set('offline-anchor',anchor);expect(await off.module.readOfflineAnchor(()=>{})).toBeNull();
  expect(await off.module.anchoredIdentity(new errors.NetworkUnavailableError(),expected,()=>{})).toBeNull();
 });
 it('serves the cached issuer registry only for the same namespace, origin and platform',async()=>{
  const a=anchorModule(),issuer={keyId:'a'.repeat(64),publicKey:'A'.repeat(43),validFrom:1,validUntil:2,revoked:false};
  await a.module.writeIssuerRegistry({namespace:'company',apiOrigin,platform:'ios',issuers:[issuer]},()=>{});
  expect(await a.module.readIssuerRegistry({namespace:'company',apiOrigin,platform:'ios'},()=>{})).toEqual([issuer]);
  expect(await a.module.readIssuerRegistry({namespace:'company',apiOrigin,platform:'android'},()=>{})).toBeNull();
  expect(await a.module.readIssuerRegistry({namespace:'company',apiOrigin:'https://other.example.com',platform:'ios'},()=>{})).toBeNull();
 });
});
