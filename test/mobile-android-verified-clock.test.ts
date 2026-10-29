/** Real custody/signatures/RLS/attendance transactions; Google transport and key enrollment are synthetic. */
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext,Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {hireEmployee} from '../core/org';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {revokeOwnIntegrityKey} from '../core/mobile-integrity-key';
import {createAndroidVerifiedClockService,AndroidClockIntegrityError} from '../packs/attendance/mobile-integrity';
import {setAttendancePolicy} from '../packs/attendance/service';
import {onlineClockClientData,type OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';
import type {AndroidClockIntegrityPolicy} from '../lib/mobile-android-clock-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';

const settings={apiOrigin:'https://hr.example.test',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const requirements:AndroidClockIntegrityPolicy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,
 locationSignals:{mock:'require_report',simulated:'deny_reported',accessory:'allow'}};
let restore:(()=>Promise<void>)|undefined,base:Base;
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-current-android-clock-secret');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function fixture(policy:AndroidClockIntegrityPolicy=requirements){
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Current Android employee',primaryEmail:randomUUID()+'@clock.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const enrollment=createAndroidEnrollmentService(settings,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:settings.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(ctx,intent);
 const key=await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:publicKey.export({type:'spki',format:'der'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]});
 const input={employmentId:e.employmentId,appInstallationId:intent.appInstallationId,keyId:key.keyId,
  command:{requestId:randomUUID(),action:'in' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},
  evidence:{platform:'android' as const,appId:settings.target.packageName,appVersion:'1.0.3',buildVersion:'4',provider:null,mock:false as boolean|null,simulated:null,accessory:null}};
 let context!:OnlineClockIntegrityData;
 const payload=()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:settings.target.packageName,requestHash:onlineClockClientDataHash(context).toString('base64url'),timestampMillis:String(Date.now())},
  appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:settings.target.packageName,certificateSha256Digest:settings.target.certificateDigests,versionCode:'4'},
  accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}});
 const transport=vi.fn<typeof fetch>(async()=>Response.json(payload())),accessToken=vi.fn(async()=> 'synthetic-google-access'),guard=vi.fn(async(_tx:Tx)=>{});
 // The synthetic guard is deliberately not evidence about deployment rollout semantics.
 const clock=createAndroidVerifiedClockService(settings,policy,accessToken,{transport,beforeCommit:guard});
 async function prepare(){const prepared=await clock.begin(ctx,input);context=prepared.context;return {...prepared,proof:{challengeId:prepared.challenge.id,signature:sign('sha256',Buffer.from(onlineClockClientData(context)),privateKey),playIntegrityToken:'synthetic-play-token'}};}
 return {ctx,input,clock,transport,accessToken,guard,payload,prepare,context:()=>context};
}
async function untouched(id:string){
 expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,id)))[0].consumedAt).toBeNull();
 expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
 expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);
}
describe('current Android evidence joins the attendance transaction',()=>{
 it('requires explicit settings/policy and a deployment transaction guard',()=>{
  const credential=vi.fn(async()=> 'synthetic-google-access');
  expect(()=>createAndroidVerifiedClockService(settings,requirements,credential)).toThrow(AndroidClockIntegrityError);
  expect(()=>createAndroidVerifiedClockService(settings,{},credential,{beforeCommit:async()=>{}})).toThrow(AndroidClockIntegrityError);
  expect(credential).not.toHaveBeenCalled();
 });
 it('decodes outside row locks and records one authoritative punch with separate signature/current/GPS evidence',async()=>{
  const f=await fixture(),p=await f.prepare();
  f.transport.mockImplementationOnce(async()=>{
   await owner.db.transaction(async tx=>{
    await tx.execute(sql`select id from mobile_integrity_key where id=${f.input.keyId} for update nowait`);
    await tx.execute(sql`select id from mobile_integrity_challenge where id=${p.challenge.id} for update nowait`);
   });return Response.json(f.payload());
  });
  const receipt=await f.clock.complete(f.ctx,f.input,p.proof);expect(receipt.direction).toBe('in');expect(f.guard).toHaveBeenCalledOnce();
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
  const links=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'));
  expect(links).toHaveLength(1);expect(links[0].payload).toMatchObject({verification:'command_signature',currentIntegrity:{verification:'google_play_standard',clientDataHash:onlineClockClientDataHash(p.context).toString('hex'),locationVerification:'not_verified',keyVerification:'not_evaluated'}});
  expect(JSON.stringify(links)).not.toMatch(/synthetic-play-token|synthetic-google-access/);
  expect(await f.clock.complete(f.ctx,f.input,p.proof)).toEqual(receipt);expect(f.transport).toHaveBeenCalledOnce();
 });
 it('refuses another signature, subject or changed command before spending a Google decode',async()=>{
  const f=await fixture(),peer=await fixture(),p=await f.prepare();
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
  await expect(f.clock.complete(f.ctx,f.input,{...p.proof,signature:sign('sha256',Buffer.from(onlineClockClientData(p.context)),other)})).rejects.toMatchObject({reason:'invalid_signature'});
  await expect(f.clock.complete(peer.ctx,f.input,p.proof)).rejects.toThrow();
  await expect(f.clock.complete(f.ctx,{...f.input,command:{...f.input.command,lat:9}},p.proof)).rejects.toMatchObject({reason:'binding_conflict'});
  expect(f.transport).not.toHaveBeenCalled();await untouched(p.challenge.id);
 });
 it.each(['outage','hash','device','mock'] as const)('refuses %s evidence without consuming the challenge or producing attendance',async failure=>{
  const f=await fixture();if(failure==='mock')f.input.evidence.mock=true;const p=await f.prepare(),value=f.payload();
  if(failure==='outage')f.transport.mockResolvedValueOnce(new Response('PRIVATE_SYNTHETIC_VENDOR_ERROR',{status:503}));
  if(failure==='hash'){value.tokenPayloadExternal.requestDetails.requestHash='B'.repeat(43);f.transport.mockResolvedValueOnce(Response.json(value));}
  if(failure==='device'){value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict=['MEETS_BASIC_INTEGRITY'];f.transport.mockResolvedValueOnce(Response.json(value));}
  await expect(f.clock.complete(f.ctx,f.input,p.proof)).rejects.toMatchObject({name:'AndroidClockIntegrityError',result:{status:failure==='outage'?'unavailable':'refused'}});
  expect(f.transport).toHaveBeenCalledOnce();expect(f.guard).not.toHaveBeenCalled();await untouched(p.challenge.id);
 });
 it('does not accept phone-supplied decoded evidence as the opaque Google token',async()=>{
  const f=await fixture(),p=await f.prepare();
  await expect(f.clock.complete(f.ctx,f.input,{...p.proof,playIntegrityToken:f.payload() as unknown as string})).rejects.toMatchObject({result:{reason:'invalid_proof'}});
  expect(f.transport).not.toHaveBeenCalled();await untouched(p.challenge.id);
 });
 it.each(['key','employment'] as const)('rechecks %s after Google work before creating attendance',async change=>{
  const f=await fixture(),p=await f.prepare(),response=deferred<Response>();f.transport.mockImplementationOnce(()=>response.promise);
  const pending=Promise.allSettled([f.clock.complete(f.ctx,f.input,p.proof)]);
  try{
   await vi.waitFor(()=>expect(f.transport).toHaveBeenCalledOnce());
   if(change==='key')await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.input.keyId});
   else await owner.db.update(schema.employment).set({hiredOn:todayInKualaLumpur(new Date(Date.now()+365*86400000))}).where(eq(schema.employment.id,f.input.employmentId));
  }finally{response.resolve(Response.json(f.payload()));}
  expect((await pending)[0]).toMatchObject({status:'rejected',reason:change==='key'?{reason:'key_unavailable'}:{name:'OwnClockEmploymentUnavailableError'}});await untouched(p.challenge.id);
 });
 it('rolls back punch, consumption and audit when the post-vendor deployment guard vetoes',async()=>{
  const f=await fixture(),p=await f.prepare();f.guard.mockImplementationOnce(async tx=>{
   await appendEvent(tx,{tenantId:f.ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:p.challenge.id,eventType:'test.current-clock.guard',actor:actorOf(f.ctx),subjectEmploymentId:f.input.employmentId,payload:{synthetic:true}});
   throw new AndroidClockIntegrityError({status:'unavailable',reason:'configuration_unavailable'});
  });
  await expect(f.clock.complete(f.ctx,f.input,p.proof)).rejects.toMatchObject({result:{reason:'configuration_unavailable'}});await untouched(p.challenge.id);
  expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'test.current-clock.guard'))).toHaveLength(0);
 });
 it('rechecks token age after tentative attendance work and rolls every write back on expiry',async()=>{
  const f=await fixture({...requirements,maxTokenAgeMs:1000}),p=await f.prepare();f.guard.mockImplementationOnce(async tx=>{await tx.execute(sql`select pg_sleep(1.2)`);});
  await expect(f.clock.complete(f.ctx,f.input,p.proof)).rejects.toMatchObject({result:{reason:'stale_token'}});expect(f.guard).toHaveBeenCalledOnce();await untouched(p.challenge.id);
 });
 it('refuses a token that ages out while awaiting the key lock before the business callback',async()=>{
  const f=await fixture({...requirements,maxTokenAgeMs:1000}),p=await f.prepare(),entered=deferred<void>(),release=deferred<void>();
  const holding=owner.db.transaction(async tx=>{await tx.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,f.input.keyId)).for('update');entered.resolve();await release.promise;});
  let pending:Promise<PromiseSettledResult<Awaited<ReturnType<typeof f.clock.complete>>>[]>|undefined;
  try{
   await entered.promise;pending=Promise.allSettled([f.clock.complete(f.ctx,f.input,p.proof)]);
   let waiting=false;const end=Date.now()+5000;
   while(Date.now()<end){const rows=await owner.db.execute(sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%mobile_integrity_key%' and query like '%for update%'`);if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
   expect(waiting).toBe(true);await owner.db.execute(sql`select pg_sleep(1.2)`);
  }finally{release.resolve();await holding;}
  expect((await pending!)[0]).toMatchObject({status:'rejected',reason:{result:{reason:'stale_token'}}});
  expect(f.transport).toHaveBeenCalledOnce();expect(f.guard).not.toHaveBeenCalled();await untouched(p.challenge.id);
 });
 it('recovers an exact concurrently committed receipt when the other Google response was cleared',async()=>{
  const f=await fixture(),p=await f.prepare(),first=deferred<Response>(),second=deferred<Response>();
  f.transport.mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise);
  const a=Promise.allSettled([f.clock.complete(f.ctx,f.input,p.proof)]);await vi.waitFor(()=>expect(f.transport).toHaveBeenCalledTimes(1));
  const b=Promise.allSettled([f.clock.complete(f.ctx,f.input,p.proof)]);
  try{
   await vi.waitFor(()=>expect(f.transport).toHaveBeenCalledTimes(2));first.resolve(Response.json(f.payload()));
   const one=(await a)[0];expect(one.status).toBe('fulfilled');
   const cleared=f.payload();cleared.tokenPayloadExternal.appIntegrity.appRecognitionVerdict='UNEVALUATED';second.resolve(Response.json(cleared));
   expect((await b)[0]).toEqual(one);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);expect(f.guard).toHaveBeenCalledOnce();
  }finally{first.resolve(Response.json(f.payload()));second.resolve(Response.json(f.payload()));await Promise.all([a,b]);}
 });
 it('recovers committed receipts after key revocation, secret outage and missing Google credentials',async()=>{
  const f=await fixture(),p=await f.prepare(),receipt=await f.clock.complete(f.ctx,f.input,p.proof);
  await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.input.keyId});vi.stubEnv('AI_CONFIG_SECRET','');
  const recovering=createAndroidVerifiedClockService(settings,requirements,null,{beforeCommit:f.guard,transport:f.transport});
  expect(await recovering.complete(f.ctx,f.input,p.proof)).toEqual(receipt);expect(f.transport).toHaveBeenCalledOnce();expect(f.guard).toHaveBeenCalledOnce();
  expect(()=>recovering.begin(f.ctx,f.input)).toThrow(AndroidClockIntegrityError);
 });
 it('keeps caller mutations during Google work out of the verified command and signature',async()=>{
  const f=await fixture(),p=await f.prepare(),response=deferred<Response>();f.transport.mockImplementationOnce(()=>response.promise);
  const pending=Promise.allSettled([f.clock.complete(f.ctx,f.input,p.proof)]);
  try{await vi.waitFor(()=>expect(f.transport).toHaveBeenCalledOnce());f.input.command.lat=9;f.input.evidence.mock=true;p.proof.signature.fill(0);}
  finally{response.resolve(Response.json(f.payload()));}
  expect((await pending)[0].status).toBe('fulfilled');
  const [capture]=await owner.db.select().from(schema.attendanceClockCapture);expect(Number(capture.lat)).toBe(3);
 });
 it('rolls back when the request is cancelled during the transaction guard',async()=>{
  const f=await fixture(),p=await f.prepare(),controller=new AbortController();f.guard.mockImplementationOnce(async()=>{controller.abort();});
  await expect(f.clock.complete(f.ctx,f.input,p.proof,controller.signal)).rejects.toMatchObject({result:{status:'unavailable'}});await untouched(p.challenge.id);
 });
});
