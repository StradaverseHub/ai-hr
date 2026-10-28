/** Actual SQL/identity/locks; synthetic attestation and explicit policy ports. Keyless (owner decision D16): no signer,
 * issuer or context encryption; the issued record (canonical JSON, digest, permits) is the authority. */
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import cbor from 'cbor';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as S from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService} from '../core/mobile-apple-enrollment';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {createAppleClockAssertionService} from '../core/mobile-apple-clock-assertion';
import {createOfflineContextIssueService,readIssuedOfflineContextTx,type OfflineContextIssuePorts,type OfflineContextSnapshot} from '../core/mobile-offline-context';
import {bindOfflineClockContext,offlineClockContextClientData,parseOfflineClockContextJson} from '../lib/mobile-offline-context';
import {onlineClockClientData} from '../lib/mobile-clock-integrity';
import {RequestBudgetExceeded} from '../lib/request-budget';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const apple={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',requiredMetadata:null}};
const android={apiOrigin:apple.apiOrigin,target:{platform:'android',packageName:'ai.hr',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-issuance-fixture-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
function settings(){return {apiOrigin:apple.apiOrigin,maximumIssuesPerHour:4};}
async function fixture(platform:'ios'|'android'='ios'){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline issuer employee',primaryEmail:randomUUID()+'@issue.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
 const enrollment=createAppleEnrollmentService(apple,{verifyProof:async()=>({publicKey:pair.publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()};let keyId:string;
 if(platform==='ios'){
  const begin=await enrollment.begin(ctx,intent);keyId=(await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId,attestation:Buffer.from('synthetic')})).keyId;
 }else{
  const enroll=createAndroidEnrollmentService(android,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey:pair.publicKey,checkedAt:Date.now(),packageName:'ai.hr',versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
  const begin=await enroll.begin(ctx,intent);keyId=(await enroll.complete(ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:pair.publicKey.export({format:'der',type:'spki'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]})).keyId;
 }
 const [key]=await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,keyId));
 const input={employmentId:e.employmentId,request:{requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url'),appInstallationId:intent.appInstallationId,keyId:key.id}},config=settings();
 let policy:OfflineContextSnapshot={policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:3600000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},sites:[],attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},target:platform==='ios'?{platform,appId:apple.target.appId,environment:'production'}:{platform,appId:'ai.hr',environment:null},permitCount:2};
 const snapshot=vi.fn<OfflineContextIssuePorts['snapshot']>(async()=>structuredClone(policy)),beforeCommit=vi.fn<OfflineContextIssuePorts['beforeCommit']>(async()=>{}),ports={snapshot,beforeCommit};
 const service=(settings:unknown=config)=>createOfflineContextIssueService(settings,ports),issue=()=>service().issue(ctx,input);
 return {ctx,e,key,pair,input,config,snapshot,beforeCommit,ports,service,issue,policy:()=>policy,setPolicy:(value:OfflineContextSnapshot)=>{policy=value;}};
}
async function counts(){return {contexts:(await owner.db.select().from(S.mobileOfflineContext)).length,permits:(await owner.db.select().from(S.mobileOfflinePermit)).length,punches:(await owner.db.select().from(S.attendancePunch)).length};}
async function untouched(){expect(await counts()).toEqual({contexts:0,permits:0,punches:0});expect(await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.context.issued'))).toHaveLength(0);}
async function retire(f:Awaited<ReturnType<typeof fixture>>,id:string){await withTenant(f.ctx,async tx=>{await tx.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)).for('update');await tx.update(S.mobileOfflineContext).set({closedAt:sql`clock_timestamp()`,closeReason:'retired',closeRequestId:randomUUID()}).where(eq(S.mobileOfflineContext.id,id));});}
describe('transactional keyless offline context issuance (owner decision D16)',()=>{
 it.each(['ios','android'] as const)('issues one exact recorded %s context and permit inventory across concurrent retries, with no key or signature',async platform=>{
  const f=await fixture(platform),[a,b]=await Promise.all([f.issue(),f.issue()]);expect(a).toEqual(b);expect(a.authorization).toBe('not_granted');
  const context=parseOfflineClockContextJson(a.raw),[row]=await owner.db.select().from(S.mobileOfflineContext);
  const scope={apiOrigin:apple.apiOrigin,installationId:f.key.installationId,tenantId:f.ctx.tenantId,companyId:base.companyId,actorId:f.ctx.userId!,employmentId:f.e.employmentId,appInstallationId:f.input.request.appInstallationId,deviceKeyId:f.key.id};
  expect(context.scope).toEqual(scope);expect(context.requestId).toBe(f.input.request.requestId);expect(context.requestNonce).toBe(f.input.request.requestNonce);
  // What the phone receives binds to its own request/scope/target, and carries no issuer or signature.
  expect(bindOfflineClockContext(a.raw,{scope,request:f.input.request,target:context.target})).toMatchObject({outcome:'bound',context});
  expect(Object.keys(JSON.parse(a.raw)).sort()).toEqual(['attendance','expiresAt','id','issuedAt','permits','policy','purpose','requestId','requestNonce','scope','sites','target','version']);
  // The record holds exactly the handed-out bytes, in plaintext, beside the digest every claim commits to.
  expect(row.contextJson).toBe(a.raw);expect(row).not.toHaveProperty('issuerKeyId');expect(row).not.toHaveProperty('contextCiphertext');
  expect(row.contextDigest).toBe(createHash('sha256').update(offlineClockContextClientData(context)).digest('hex'));
  expect(context.expiresAt-context.issuedAt).toBe(f.policy().policy.windowMs);
  expect((await withTenant(f.ctx,tx=>readIssuedOfflineContextTx(tx,row,apple.apiOrigin))).raw).toBe(a.raw);
  expect(await counts()).toEqual({contexts:1,permits:2,punches:0});expect(f.snapshot).toHaveBeenCalledOnce();expect(f.beforeCommit.mock.calls.map(call=>call[2].mode).sort()).toEqual(['issue','recover']);
  const events=await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.context.issued'));expect(events).toHaveLength(1);const payload=events[0].payload;if(payload===null||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid issuance audit payload');expect(Object.keys(payload).sort()).toEqual(['keyId','permitCount','policyRevision']);
 });
 it('recovers the exact recorded bytes and anchors through changed snapshots and a changed issuance budget, with no key to rotate',async()=>{
  const f=await fixture(),original=await f.issue();f.snapshot.mockRejectedValueOnce(new Error('must not fetch a new snapshot'));
  const retry=await f.service({...settings(),maximumIssuesPerHour:1}).issue(f.ctx,f.input);expect(retry).toEqual(original);expect(f.snapshot).toHaveBeenCalledOnce();
  const [row]=await owner.db.select().from(S.mobileOfflineContext);expect(row.contextJson).toBe(retry.raw);
 });
 it('keeps expired context retries stable and refuses allocating a replacement stream implicitly',async()=>{
  const f=await fixture();f.setPolicy({...f.policy(),policy:{...f.policy().policy,windowMs:1000}});const original=await f.issue(),context=parseOfflineClockContextJson(original.raw);
  await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(context.expiresAt).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
  expect(await f.issue()).toEqual(original);
  await expect(f.service().issue(f.ctx,{...f.input,request:{...f.input.request,requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')}})).rejects.toMatchObject({reason:'offline_pending'});
  expect(await counts()).toEqual({contexts:1,permits:2,punches:0});
 });
 it('refuses changed request bindings and client-supplied policy, scope, key or digest authority',async()=>{
  const f=await fixture();await f.issue();
  await expect(f.service().issue(f.ctx,{...f.input,request:{...f.input.request,requestNonce:randomBytes(32).toString('base64url')}})).rejects.toMatchObject({reason:'binding_conflict'});
  for(const extra of [{actorId:randomUUID()},{companyId:randomUUID()},{policy:f.policy()},{issuer:{algorithm:'ed25519',keyId:'c'.repeat(64)}},{contextDigest:'c'.repeat(64)}])await expect(f.service().issue(f.ctx,{...f.input,...extra})).rejects.toThrow();
  await expect(f.service().issue(f.ctx,{...f.input,request:{...f.input.request,appInstallationId:randomUUID()}})).rejects.toMatchObject({reason:'key_unavailable'});
  expect(await counts()).toEqual({contexts:1,permits:2,punches:0});
 });
 it('refuses peer/other-tenant employment or keys before policy reads or writes',async()=>{
  const f=await fixture(),peer=await fixture();
  await expect(f.service().issue(peer.ctx,f.input)).rejects.toThrow();
  await expect(f.service().issue(f.ctx,{...f.input,request:{...f.input.request,keyId:peer.key.id}})).rejects.toMatchObject({reason:'key_unavailable'});
  await expect(f.service().issue({...f.ctx,tenantId:randomUUID()},f.input)).rejects.toThrow();expect(f.snapshot).not.toHaveBeenCalled();await untouched();
 });
 it('reconciles active online work before issuing, while preserving exact consumed-proof recovery under the later lease',async()=>{
  const f=await fixture(),online=createAppleClockAssertionService(apple),input={employmentId:f.e.employmentId,appInstallationId:f.input.request.appInstallationId,keyId:f.key.id,command:{requestId:randomUUID(),action:'out' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},evidence:{platform:'ios' as const,appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
  const begin=await online.begin(f.ctx,input);await expect(f.issue()).rejects.toMatchObject({reason:'online_pending'});expect(f.snapshot).not.toHaveBeenCalled();await untouched();
  const auth=Buffer.alloc(37);createHash('sha256').update(apple.target.appId).digest().copy(auth);auth.writeUInt32BE(1,33);
  const nonce=createHash('sha256').update(auth).update(createHash('sha256').update(onlineClockClientData(begin.context)).digest()).digest(),proof={challengeId:begin.challenge.id,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,f.pair.privateKey)})},operation=vi.fn(async()=>null);
  expect((await online.consume(f.ctx,input,proof,operation)).state).toBe('consumed');await f.issue();
  expect((await online.consume(f.ctx,input,{...proof,assertion:Buffer.from('already consumed')},operation)).state).toBe('already_consumed');expect(operation).toHaveBeenCalledOnce();
 });
 it('charges only new issuance against the configured actor budget and never reopens a closed request',async()=>{
  const f=await fixture();f.config.maximumIssuesPerHour=1;const original=await f.issue();expect(await f.issue()).toEqual(original);await retire(f,original.contextId);
  await expect(f.issue()).rejects.toMatchObject({reason:'context_closed'});
  await expect(f.service().issue(f.ctx,{...f.input,request:{...f.input.request,requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')}})).rejects.toBeInstanceOf(RequestBudgetExceeded);
  expect(await counts()).toEqual({contexts:1,permits:2,punches:0});
 });
 it('rolls back the context, permit inventory, audit and admission budget on the final policy guard',async()=>{
  const f=await fixture();f.config.maximumIssuesPerHour=1;f.beforeCommit.mockRejectedValueOnce(new Error('policy changed'));
  await expect(f.issue()).rejects.toThrow('policy changed');await untouched();
  expect((await f.issue()).outcome).toBe('issued');
 });
 // 'record' replaces the former 'storage' case (D16: the context service holds no secret; the deployment commit guard still
 // rechecks claim/photo encryption storage, test/mobile-offline-deployment-config.test.ts). The record itself is rechecked.
 it.each(['employment','key','record'] as const)('rechecks %s after the final guard and rolls back tentative writes',async change=>{
  const f=await fixture();f.beforeCommit.mockImplementationOnce(async(tx,_ctx,checked)=>{
   if(change==='employment')await tx.update(S.employment).set({hiredOn:'2099-01-01'}).where(eq(S.employment.id,f.e.employmentId));
   if(change==='key')await tx.update(S.mobileIntegrityKey).set({revokedAt:sql`clock_timestamp()`}).where(eq(S.mobileIntegrityKey.id,f.key.id));
   if(change==='record')await tx.update(S.mobileOfflineContext).set({closedAt:sql`clock_timestamp()`,closeReason:'retired',closeRequestId:randomUUID()}).where(eq(S.mobileOfflineContext.id,checked.context.id));
  });
  await expect(f.issue()).rejects.toThrow();await untouched();
  expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].revokedAt).toBeNull();
 });
 it('does not return a newly minted context after its window expires during commit checks',async()=>{
  const f=await fixture();f.setPolicy({...f.policy(),policy:{...f.policy().policy,windowMs:200}});
  f.beforeCommit.mockImplementationOnce(async tx=>{await tx.execute(sql`select pg_sleep(0.25)`);});
  await expect(f.issue()).rejects.toMatchObject({reason:'time_unavailable'});await untouched();
 });
 it('rejects unavailable/off/malformed snapshot policy and wrong app/environment before issuing any permits',async()=>{
  const f=await fixture(),policy=f.policy();
  for(const changed of [{...policy,policy:{...policy.policy,offlineEnabled:false}},{...policy,permitCount:33},{...policy,policy:{...policy.policy,geofencingRequired:true}},{...policy,target:{...policy.target,appId:'KLMNOPQRST.ai.hr'}},{...policy,target:{...policy.target,environment:'development'}}]){
   f.snapshot.mockResolvedValueOnce(changed);await expect(f.issue()).rejects.toThrow();await untouched();
  }
 });
 it('requires configured admission and both trusted policy ports, and accepts no key material at all',async()=>{
  const f=await fixture();
  for(const config of [{...f.config,maximumIssuesPerHour:0},{...f.config,privateKey:generateKeyPairSync('ed25519').privateKey},{...f.config,issuer:{keyId:'c'.repeat(64)}},{apiOrigin:apple.apiOrigin}])expect(()=>f.service(config)).toThrow();
  expect(()=>createOfflineContextIssueService(f.config,{snapshot:f.snapshot} as never)).toThrow();
  await untouched();
 });
 it('needs no AI_CONFIG_SECRET to issue or recover: the context record is plaintext, not encrypted',async()=>{
  // Enrollment (in the fixture) still stores its receipt encrypted; only the context path is secret-free.
  const f=await fixture();vi.stubEnv('AI_CONFIG_SECRET','');const original=await f.issue();
  expect(await f.issue()).toEqual(original);expect(await counts()).toEqual({contexts:1,permits:2,punches:0});
 });
 it('keeps record recovery bound to the exact canonical bytes, recorded digest, bound columns and the real permit inventory',async()=>{
  const f=await fixture();await f.issue();const [row]=await owner.db.select().from(S.mobileOfflineContext),stored=JSON.parse(row.contextJson);
  // A wider geofence with the original digest, the same context with a recomputed-looking digest, whitespace or reordered
  // keys (not the canonical text), another request id, a missing permit: every one is refused, none is repaired.
  const wider=JSON.stringify({...stored,sites:[{id:randomUUID(),name:'Anywhere',lat:3,lng:101,radiusM:100000}],policy:{...stored.policy,geofencingRequired:true}});
  const reordered=JSON.stringify(Object.fromEntries(Object.entries(stored).reverse()));
  for(const changed of [{...row,requestId:randomUUID()},{...row,contextJson:wider},{...row,contextJson:row.contextJson+' '},{...row,contextJson:reordered},{...row,contextJson:JSON.stringify(stored,null,1)},
   {...row,contextJson:JSON.stringify({...stored,issuer:{algorithm:'ed25519',keyId:'d'.repeat(64)}})},{...row,contextDigest:'d'.repeat(64)},{...row,permitCount:1},{...row,expiresAt:new Date(row.expiresAt.getTime()+1)}])
   await expect(withTenant(f.ctx,tx=>readIssuedOfflineContextTx(tx,changed,apple.apiOrigin))).rejects.toMatchObject({reason:'configuration_unavailable'});
  // Non-vacuous: the reordered text parses to the same context, so only the exact-bytes rule refuses it.
  expect(offlineClockContextClientData(JSON.parse(reordered))).toBe(offlineClockContextClientData(stored));
  await expect(f.service({...f.config,apiOrigin:'https://other.example.com'}).issue(f.ctx,f.input)).rejects.toMatchObject({reason:'configuration_unavailable'});
 });
 it('rechecks employment after waiting for the actual registered-key lock',async()=>{
  const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const holding=owner.db.transaction(async tx=>{await tx.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)).for('update');entered();await held;await tx.update(S.employment).set({hiredOn:'2099-01-01'}).where(eq(S.employment.id,f.e.employmentId));});
  try{
   await started;const issuing=Promise.allSettled([f.issue()]);
   try{
    const deadline=Date.now()+5000;let waiting=false;
    while(Date.now()<deadline){const rows=await owner.db.execute(sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%mobile_integrity_key%' and query like '%for update%'`);if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
   }finally{release();}
   await holding;expect((await issuing)[0]).toMatchObject({status:'rejected'});expect(f.snapshot).not.toHaveBeenCalled();await untouched();
  }finally{release();await holding.catch(()=>{});}
 });
});
