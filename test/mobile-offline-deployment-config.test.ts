/** Offline deployment configuration and trusted-port assembly: real per-request env reads, catalog readiness, SQL/RLS,
 * Ed25519 signatures, commit guards and rollback. Every key is generated in-process; enrollment proof is synthetic. The
 * assembly builds the production snapshot port per request from the deployment (window, permit count, target: one
 * owner); the test only observes its calls and can run a hook inside it. The real adjudicator decides uploaded claims. */
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import cbor from 'cbor';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as S from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService} from '../core/mobile-apple-enrollment';
import type {OfflineContextIssuePorts} from '../core/mobile-offline-context';
import {readMobileOfflineDeployment,isMobileOfflineStorageReady} from '../core/mobile-offline-rollout';
import {createDeployedOfflineClockOperations} from '../lib/mobile-api/deployed-offline-clock';
import {offlineContextIssuerIdentity,verifyOfflineClockContextSignature} from '../lib/mobile-api/offline-context-signature';
import {OfflineClockContextEnvelope,offlineClockContextClientData,type OfflineClockContextData} from '../lib/mobile-offline-context';
import {offlineClockClaimClientData,type OfflineClockClaimData} from '../lib/mobile-offline-clock';
import * as attendance from '../packs/attendance/service';
import {setAttendancePolicy} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const apiOrigin='https://hr.example.com',appId='ABCDEFGHIJ.ai.hr';
const ios={apiOrigin,target:{platform:'ios',appId,environment:'production',requiredMetadata:null}};
const android={apiOrigin,target:{platform:'android',packageName:'ai.hr',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const androidPolicy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,locationSignals:{mock:'deny_reported',simulated:'deny_reported',accessory:'allow'}};
const ENV=['AIHR_MOBILE_OFFLINE_POLICY','AIHR_MOBILE_OFFLINE_SIGNING_KEY','AIHR_MOBILE_CLOCK_POLICY','AIHR_MOBILE_ENROLLMENT_POLICY'];
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
// Observe the real port the assembly builds (and run a hook inside it); the values are never replaced.
const realPort=attendance.offlineClockSnapshotPort,snapshot=vi.fn<OfflineContextIssuePorts['snapshot']>(async()=>undefined),deployments:unknown[]=[];
let hook:(()=>void)|null=null;
vi.spyOn(attendance,'offlineClockSnapshotPort').mockImplementation(deployment=>{deployments.push(deployment);const port=realPort(deployment);
 return async(...args)=>{const run=hook;hook=null;run?.();await snapshot(...args);return port(...args);};});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-deployment-fixture-secret-2026');for(const name of ENV)vi.stubEnv(name,'');snapshot.mockClear();deployments.length=0;hook=null;await resetDb();base=await seedBase();});
/** The company's policy row through its own writer, then 0647's switch (the snapshot owner reads both). */
async function offlineOn(enabled=true){
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 await owner.db.execute(sql`update attendance_policy set offline_clocking_enabled=${enabled} where company_id=${base.companyId}::uuid`);
}
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
type Signer=ReturnType<typeof signer>;
function signer(validity:{validFrom?:number;validUntil?:number;revoked?:boolean}={}){
 const {privateKey}=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(privateKey);
 return {pem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),issuer:{...identity,validFrom:Date.now()-86400000,validUntil:Date.now()+7*86400000,revoked:false,...validity}};
}
async function fixture(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline deployment employee',primaryEmail:randomUUID()+'@deploy.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
 const enrollment=createAppleEnrollmentService(ios,{verifyProof:async()=>({publicKey:pair.publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(ctx,intent);
 const keyId=(await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId,attestation:Buffer.from('synthetic')})).keyId;
 const [key]=await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,keyId));
 const request=()=>({employmentId:e.employmentId,request:{requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url'),appInstallationId:intent.appInstallationId,keyId}});
 return {e,ctx,key,pair,request,snapshot,ops:createDeployedOfflineClockOperations('ios'),onSnapshot:(next:()=>void)=>{hook=next;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const policyFor=(f:Fixture,s:Signer,overrides:Record<string,unknown>={})=>({version:1,mode:'active',signingKeyId:s.issuer.keyId,issuers:[s.issuer],windowMs:86400000,permitCount:2,maximumIssuesPerHour:4,
 photoRetentionMs:2592000000,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[f.ctx.userId]}],...overrides});
const clockFor=(f:Fixture,platforms:Record<string,unknown>={ios:{configuration:ios},android:null},actorIds=[f.ctx.userId])=>JSON.stringify({version:1,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds,legacySelfService:'allow_unverified',platforms}]});
function configure(f:Fixture,s:Signer,overrides:Record<string,unknown>={},pem=s.pem){
 vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',clockFor(f));vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,overrides)));vi.stubEnv('AIHR_MOBILE_OFFLINE_SIGNING_KEY',pem);
}
const read=(f:Fixture,platform:'ios'|'android'='ios',companyId=base.companyId)=>readMobileOfflineDeployment(platform,f.ctx,companyId);
const notConfigured={outcome:'unavailable',code:'not_configured'},configurationUnavailable={outcome:'unavailable',code:'configuration_unavailable'};
async function refused(f:Fixture){await expect(read(f)).rejects.toMatchObject({reason:'configuration_unavailable'});expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toEqual(configurationUnavailable);}
async function counts(){
 const [row]=await owner.db.execute<{contexts:number;permits:number;claims:number;punches:number;issued:number;processed:number}>(sql`select (select count(*) from mobile_offline_context)::int contexts,(select count(*) from mobile_offline_permit)::int permits,
  (select count(*) from mobile_offline_claim)::int claims,(select count(*) from attendance_punch)::int punches,(select count(*) from domain_event where event_type='mobile.offline.context.issued')::int issued,
  (select count(*) from domain_event where event_type='mobile.offline.claim.processed')::int processed`);return {...row};
}
const contextOf=(raw:string)=>OfflineClockContextEnvelope.parse(JSON.parse(raw)).context;
function signedClaim(f:Fixture,context:OfflineClockContextData,sequence:number,previousSha256:string|null){
 const claim:OfflineClockClaimData={version:1,purpose:'attendance.clock.offline.claim',scope:context.scope,context:{id:context.id,sha256:createHash('sha256').update(offlineClockContextClientData(context)).digest('hex')},permit:context.permits[sequence-1],chain:{sequence,previousSha256},
  command:{requestId:randomUUID(),action:'out',lat:3,lng:101,accuracy:5,sampledAt:context.issuedAt,photo:null},time:{claimedAt:context.issuedAt,elapsed:{status:'elapsed',minimumNs:'0',maximumNs:'1000000000',continuity:'same_process'}},
  evidence:{platform:'ios',appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 const bytes=Buffer.from(offlineClockClaimClientData(claim)),auth=Buffer.alloc(37);createHash('sha256').update(f.key.appId).digest().copy(auth);auth.writeUInt32BE(sequence,33);
 const nonce=createHash('sha256').update(auth).update(createHash('sha256').update(bytes).digest()).digest();
 return {claim,proof:{platform:'ios' as const,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,f.pair.privateKey)}).toString('base64')}};
}
/** Wait on the database clock until the claim's first whole proven second has passed (the adjudicator needs one). */
async function settled(context:{issuedAt:number}){
 const whole=Math.ceil(context.issuedAt/1000)*1000;
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(whole).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
}
describe('offline deployment configuration',()=>{
 it('stays off when the policy is absent, before any database, snapshot or vendor work',async()=>{
  const f=await fixture(),s=signer();vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',clockFor(f));vi.stubEnv('AIHR_MOBILE_OFFLINE_SIGNING_KEY',s.pem);
  expect(await read(f)).toBeNull();
  expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toEqual(notConfigured);expect(await f.ops.issue(f.ctx,f.request())).toEqual(notConfigured);
  expect(await f.ops.close(f.ctx,{contextId:randomUUID(),closeRequestId:randomUUID(),consumedThrough:0})).toEqual(notConfigured);expect(await f.ops.consume(f.ctx,{})).toEqual(notConfigured);
  expect(f.snapshot).not.toHaveBeenCalled();expect(await counts()).toMatchObject({contexts:0,permits:0,issued:0});
  expect(()=>createDeployedOfflineClockOperations('web' as never)).toThrow();expect(deployments).toEqual([]);
 });
 it('refuses malformed, out-of-bounds, inconsistent and oversized policy as configuration_unavailable',async()=>{
  const f=await fixture(),s=signer(),valid=policyFor(f,s),other=signer();configure(f,s);expect(await read(f)).toMatchObject({mode:'active'});
  const many=Array.from({length:17},()=>signer().issuer);
  const bad:unknown[]=['{','null','[]',{...valid,version:2},{...valid,mode:'paused'},{...valid,extra:true},{...valid,windowMs:72*3600000+1},{...valid,windowMs:59999},{...valid,windowMs:1.5},{...valid,permitCount:0},{...valid,permitCount:33},
   {...valid,maximumIssuesPerHour:0},{...valid,maximumIssuesPerHour:25},{...valid,photoRetentionMs:3599999},{...valid,photoRetentionMs:366*86400000+1},{...valid,issuers:[]},{...valid,issuers:[s.issuer,...many.slice(1)]},
   {...valid,issuers:[s.issuer,s.issuer]},{...valid,issuers:[{...s.issuer,publicKey:other.issuer.publicKey}]},{...valid,signingKeyId:other.issuer.keyId},{...valid,issuers:[{...s.issuer,validUntil:s.issuer.validFrom}]},
   {...valid,entries:[{...valid.entries[0],actorIds:[f.ctx.userId,f.ctx.userId]}]},{...valid,entries:[valid.entries[0],{...valid.entries[0],actorIds:[randomUUID()]}]},{...valid,entries:[{...valid.entries[0],actorIds:[]}]},
   {...valid,entries:[{...valid.entries[0],tenantId:'not-a-uuid'}]}];
  for(const value of bad){vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',typeof value==='string'?value:JSON.stringify(value));await refused(f);}
  // Oversized: a valid policy padded past 262144 UTF-8 bytes is refused before parsing.
  vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(valid)+' '.repeat(262144));await refused(f);
  vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(valid));expect(await read(f)).toMatchObject({mode:'active'});
  expect(f.snapshot).not.toHaveBeenCalled();expect(await counts()).toMatchObject({contexts:0});
 });
 it('requires the Ed25519 private key of the unrevoked, currently valid signing issuer',async()=>{
  const f=await fixture(),s=signer(),other=signer();
  configure(f,s);const ok=await read(f);
  expect(ok).toMatchObject({platform:'ios',mode:'active',apiOrigin,target:{platform:'ios',appId,environment:'production'},signingKeyId:s.issuer.keyId,windowMs:86400000,permitCount:2,maximumIssuesPerHour:4,photoRetentionMs:2592000000});
  expect(ok?.signing?.issuer).toEqual(s.issuer);
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}).toString(),rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const publicPem=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
  for(const pem of [other.pem,'',ec,rsa,publicPem,'not a key','x'.repeat(5000)]){configure(f,s,{},pem);await refused(f);}
  for(const validity of [{revoked:true},{validUntil:Date.now()-1},{validFrom:Date.now()+3600000}]){const t=signer(validity);configure(f,t);await refused(f);}
  // A one-line value with literal \n separators reads as the same key.
  configure(f,s,{},s.pem.trim().replace(/\n/g,'\\n'));expect((await read(f))?.signing?.issuer.keyId).toBe(s.issuer.keyId);
  // Drain keeps upload/close for a revoked signer (incident response); a key, if present, must still match.
  const revoked=signer({revoked:true});configure(f,revoked,{mode:'drain'});expect(await read(f)).toMatchObject({mode:'drain',signing:{issuer:{revoked:true}}});
  configure(f,revoked,{mode:'drain'},'');expect(await read(f)).toMatchObject({mode:'drain',signing:null});
  configure(f,revoked,{mode:'drain'},other.pem);await refused(f);
 });
 it('requires the actor in both the offline and the platform clock rollouts, which owns origin and target',async()=>{
  const f=await fixture(),s=signer(),peer=await fixture();configure(f,s);
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');expect(await read(f)).toBeNull();expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toEqual(notConfigured);
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',clockFor(f,undefined,[peer.ctx.userId]));expect(await read(f)).toBeNull();
  const androidOnly={ios:null,android:{configuration:{settings:android,policy:androidPolicy},cloudProjectNumber:'123456789'}};
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',clockFor(f,androidOnly));expect(await read(f)).toBeNull();
  expect(await read(f,'android')).toMatchObject({platform:'android',apiOrigin,target:{platform:'android',appId:'ai.hr',environment:null}});
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','{');await refused(f);
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',clockFor(f));expect(await read(f,'ios',randomUUID())).toBeNull();
  vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,{entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[peer.ctx.userId]}]})));expect(await read(f)).toBeNull();
  expect(await f.ops.issue(f.ctx,f.request())).toEqual(notConfigured);
  // Another actor's employment is refused before any deployment read.
  configure(f,s);expect(await f.ops.capabilities(f.ctx,peer.e.employmentId)).toEqual({outcome:'refused',code:'subject_unavailable'});
  expect(f.snapshot).not.toHaveBeenCalled();expect(await counts()).toMatchObject({contexts:0});
 });
 it('fails closed when draft 0647 storage or secret storage is not ready',async()=>{
  const f=await fixture(),s=signer();configure(f,s);expect(await isMobileOfflineStorageReady(f.ctx)).toBe(true);await read(f);
  await owner.db.execute(sql`ALTER TABLE mobile_offline_claim DISABLE TRIGGER mobile_offline_claim_ordered`);
  try{expect(await isMobileOfflineStorageReady(f.ctx)).toBe(false);await refused(f);expect(await f.ops.issue(f.ctx,f.request())).toEqual(configurationUnavailable);}
  finally{await owner.db.execute(sql`ALTER TABLE mobile_offline_claim ENABLE TRIGGER mobile_offline_claim_ordered`);}
  expect(await isMobileOfflineStorageReady(f.ctx)).toBe(true);
  vi.stubEnv('AI_CONFIG_SECRET','');await refused(f);
  expect(f.snapshot).not.toHaveBeenCalled();expect(await counts()).toMatchObject({contexts:0});
 });
 it('sees every environment change on the next call, with no cache',async()=>{
  const f=await fixture(),s=signer(),t=signer();configure(f,s);await offlineOn();expect(await read(f)).toMatchObject({windowMs:86400000,mode:'active'});
  vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,{windowMs:3600000,permitCount:8})));expect(await read(f)).toMatchObject({windowMs:3600000,permitCount:8});
  vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,{mode:'drain'})));expect(await read(f)).toMatchObject({mode:'drain'});
  expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toMatchObject({outcome:'offline',enabled:false});
  // Rotation: the new signer is listed and selected, the old one stays listed and unrevoked.
  configure(f,t,{issuers:[s.issuer,t.issuer]});expect((await read(f))?.signing?.issuer.keyId).toBe(t.issuer.keyId);
  vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY','');expect(await read(f)).toBeNull();expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toEqual(notConfigured);
 });
});
describe('deployed offline clock assembly',()=>{
 it('issues with the deployment window, permit count and clock-rollout target, and recovers exact retries',async()=>{
  const f=await fixture(),s=signer();configure(f,s);await offlineOn();
  expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toEqual({outcome:'offline',enabled:true,apiOrigin,companyId:base.companyId,issuers:[s.issuer],windowMs:86400000,permitCount:2});
  const input=f.request(),issued=await f.ops.issue(f.ctx,input);if(issued.outcome!=='issued')throw new Error('Not issued: '+JSON.stringify(issued));
  const context=contextOf(issued.context);
  expect(context.policy.windowMs).toBe(86400000);expect(context.expiresAt-context.issuedAt).toBe(86400000);expect(context.permits).toHaveLength(2);
  expect(context.target).toEqual({platform:'ios',appId,environment:'production'});expect(context.issuer.keyId).toBe(s.issuer.keyId);expect(context.scope.apiOrigin).toBe(apiOrigin);
  expect(verifyOfflineClockContextSignature(issued.context,[s.issuer],context.scope)).toMatchObject({outcome:'signature_valid'});
  expect(await f.ops.issue(f.ctx,input)).toEqual(issued);expect(f.snapshot).toHaveBeenCalledOnce();expect(await counts()).toMatchObject({contexts:1,permits:2,issued:1});
  // One owner: the port was built from the deployment's own window, permit count and clock-rollout target.
  // Built per request (issue and its exact retry), always from the same deployment facts.
  expect(deployments).toEqual(Array(2).fill({target:{platform:'ios',appId,environment:'production'},windowMs:86400000,permitCount:2}));
  // The open stream is the lease: a second request is refused until it is reconciled.
  expect(await f.ops.issue(f.ctx,f.request())).toEqual({outcome:'refused',code:'offline_pending'});
  expect(await f.ops.issue(f.ctx,{employmentId:'not-a-uuid'})).toEqual({outcome:'refused',code:'invalid_request'});
 });
 it('refuses issuance cleanly when the trusted snapshot says offline is off, or the company requires a registered device',async()=>{
  const f=await fixture(),s=signer();configure(f,s);
  // No attendance_policy row: the company setting is OFF.
  expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toEqual({outcome:'refused',code:'offline_disabled'});
  expect(await f.ops.issue(f.ctx,f.request())).toEqual({outcome:'refused',code:'offline_disabled'});expect(f.snapshot).toHaveBeenCalledOnce();expect(await counts()).toMatchObject({contexts:0,permits:0,issued:0});
  await offlineOn(false);expect(await f.ops.issue(f.ctx,f.request())).toEqual({outcome:'refused',code:'offline_disabled'});
  // Owner decision 5 (2026-10-28): offline on, but the company requires a registered device. Nothing is written.
  await offlineOn();await owner.db.execute(sql`update attendance_policy set require_registered_device=true where company_id=${base.companyId}::uuid`);
  expect(await f.ops.issue(f.ctx,f.request())).toEqual({outcome:'refused',code:'device_required'});expect(await counts()).toMatchObject({contexts:0,permits:0,issued:0});
  await owner.db.execute(sql`update attendance_policy set require_registered_device=false where company_id=${base.companyId}::uuid`);
  expect((await f.ops.issue(f.ctx,f.request())).outcome).toBe('issued');expect(await counts()).toMatchObject({contexts:1,issued:1});
 });
 it('vetoes a deployment change during issuance and rolls back the context, permits, audit and budget',async()=>{
  const f=await fixture(),s=signer(),input=f.request(),strict={maximumIssuesPerHour:1};configure(f,s,strict);await offlineOn();
  const changes:[string,()=>void,unknown][]=[
   ['drain',()=>vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,{...strict,mode:'drain'}))),{outcome:'unavailable',code:'draining'}],
   ['removed',()=>vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',''),notConfigured],
   ['window',()=>vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,{...strict,windowMs:3600000}))),configurationUnavailable],
   ['clock rollout',()=>vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',''),notConfigured],
   ['signer revoked',()=>vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify(policyFor(f,s,{...strict,issuers:[{...s.issuer,revoked:true}]}))),configurationUnavailable],
   ['signing key',()=>vi.stubEnv('AIHR_MOBILE_OFFLINE_SIGNING_KEY',signer().pem),configurationUnavailable],
  ];
  for(const [label,change,expected] of changes){
   configure(f,s,strict);f.onSnapshot(change);expect(await f.ops.issue(f.ctx,input),label).toEqual(expected);
   expect(await counts(),label).toMatchObject({contexts:0,permits:0,issued:0});
  }
  // Every vetoed attempt released its admission budget (one per hour), so the same request now issues.
  configure(f,s,strict);expect((await f.ops.issue(f.ctx,input)).outcome).toBe('issued');expect(await counts()).toMatchObject({contexts:1,permits:2,issued:1});
 });
 it('in drain mode recovers exact responses and closes, but refuses new issuance before any snapshot read',async()=>{
  const f=await fixture(),s=signer();configure(f,s);await offlineOn();
  const input=f.request(),issued=await f.ops.issue(f.ctx,input);if(issued.outcome!=='issued')throw new Error('Not issued');
  configure(f,s,{mode:'drain'});
  expect(await f.ops.capabilities(f.ctx,f.e.employmentId)).toMatchObject({outcome:'offline',enabled:false});
  expect(await f.ops.issue(f.ctx,input)).toEqual(issued);
  const closed=await f.ops.close(f.ctx,{contextId:issued.contextId,closeRequestId:randomUUID(),consumedThrough:0});expect(closed).toMatchObject({outcome:'closed',reason:'retired',consumedThrough:0});
  expect(await f.ops.close(f.ctx,{contextId:randomUUID(),closeRequestId:randomUUID(),consumedThrough:0})).toEqual({outcome:'refused',code:'context_unavailable'});
  // With the lease released, a new request reaches the issuance path and is refused as draining before the snapshot.
  expect(await f.ops.issue(f.ctx,f.request())).toEqual({outcome:'unavailable',code:'draining'});expect(f.snapshot).toHaveBeenCalledOnce();
  configure(f,s,{mode:'drain'},'');expect(await f.ops.issue(f.ctx,f.request())).toEqual({outcome:'unavailable',code:'draining'});
  configure(f,s);expect((await f.ops.issue(f.ctx,f.request())).outcome).toBe('issued');expect(f.snapshot).toHaveBeenCalledTimes(2);
  expect(await counts()).toMatchObject({contexts:2,permits:4,issued:2});
 });
 it('commits an offline_disabled refusal in drain mode, and vetoes a removed deployment after tentative claim writes',async()=>{
  const f=await fixture(),s=signer();configure(f,s);await offlineOn();
  const issued=await f.ops.issue(f.ctx,f.request());if(issued.outcome!=='issued')throw new Error('Not issued');const context=contextOf(issued.context);
  configure(f,s,{mode:'drain'});
  // The company switched offline OFF after issuance. The refusal commits and advances the stream.
  await offlineOn(false);
  const first=await f.ops.consume(f.ctx,signedClaim(f,context,1,null));
  if(first.outcome!=='processed')throw new Error('No receipt: '+JSON.stringify(first));
  expect(first.receipt).toMatchObject({outcome:'refused',reason:'offline_disabled',sequence:1,captureId:null});
  expect(await counts()).toMatchObject({claims:1,punches:0,processed:1});
  expect((await owner.db.select().from(S.mobileOfflineContext))[0]).toMatchObject({nextSequence:2,closedAt:null});
  await offlineOn();
  await settled(context);
  const next=signedClaim(f,context,2,first.receipt.digest);
  f.onSnapshot(()=>vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',''));
  expect(await f.ops.consume(f.ctx,next)).toEqual(notConfigured);expect(f.snapshot).toHaveBeenCalledTimes(2);
  expect(await counts()).toMatchObject({claims:1,punches:0,processed:1});
  const [stream]=await owner.db.select().from(S.mobileOfflineContext);expect(stream).toMatchObject({nextSequence:2,previousDigest:first.receipt.digest,closedAt:null});
  expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].assertionCounter).toBe(1);
  configure(f,s,{mode:'drain'});const retried=await f.ops.consume(f.ctx,next);
  if(retried.outcome!=='processed')throw new Error('No receipt: '+JSON.stringify(retried));expect(retried.receipt.sequence).toBe(2);
  expect(await counts()).toMatchObject({claims:2,processed:2});expect((await owner.db.select().from(S.mobileOfflineContext))[0]).toMatchObject({nextSequence:3,closeReason:'exhausted'});
  expect(await f.ops.consume(f.ctx,next)).toEqual(retried);
 });
 it('does not advertise or issue Android without a Google credential, and refuses an iOS key on the Android assembly',async()=>{
  const f=await fixture(),s=signer();configure(f,s);await offlineOn();
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',clockFor(f,{ios:{configuration:ios},android:{configuration:{settings:android,policy:androidPolicy},cloudProjectNumber:'123456789'}}));
  vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');
  const issued=await f.ops.issue(f.ctx,f.request());if(issued.outcome!=='issued')throw new Error('Not issued');
  const ops=createDeployedOfflineClockOperations('android');
  expect(await ops.capabilities(f.ctx,f.e.employmentId)).toEqual(configurationUnavailable);expect(await ops.issue(f.ctx,f.request())).toEqual(configurationUnavailable);
  // The Android preparer refuses a key of another platform before any provider work, even with a credential port.
  const google=createDeployedOfflineClockOperations('android',{androidPlay:{accessToken:async()=>'synthetic-access',transport:async()=>{throw new Error('Unexpected vendor call');}}});
  expect(await google.consume(f.ctx,signedClaim(f,contextOf(issued.context),1,null),undefined,{playIntegrityToken:'synthetic-play',syncBuildVersion:'4'})).toEqual(configurationUnavailable);
  expect(await counts()).toMatchObject({claims:0});
 });
});
