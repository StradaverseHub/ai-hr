/** Actual draft SQL, RLS, immutable state, deferred atomicity, online carriers and key counter locks. */
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
import {createAndroidClockSignatureService} from '../core/mobile-android-clock-signature';
import {revokeOwnIntegrityKey} from '../core/mobile-integrity-key';
import {assertNoOfflineClockLeaseTx} from '../core/mobile-offline-lease';
import {onlineClockClientData} from '../lib/mobile-clock-integrity';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
const apple={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',requiredMetadata:null}};
const android={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.hr',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-stream-fixture-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function fixture(platform:'ios'|'android'='ios'){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline stream employee',primaryEmail:randomUUID()+'@offline.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,e.personId,'employee'),ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()};
 let keyId:string;
 if(platform==='ios'){
  const jwk=pair.publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const enroll=createAppleEnrollmentService(apple,{verifyProof:async()=>({publicKey:pair.publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
  const begin=await enroll.begin(ctx,intent);keyId=(await enroll.complete(ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId,attestation:Buffer.from('synthetic')})).keyId;
 }else{
  const enroll=createAndroidEnrollmentService(android,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey:pair.publicKey,checkedAt:Date.now(),packageName:'ai.hr',versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
  const begin=await enroll.begin(ctx,intent);keyId=(await enroll.complete(ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:pair.publicKey.export({format:'der',type:'spki'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]})).keyId;
 }
 const [key]=await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,keyId));
 const issuedAt=new Date(Date.now()-3600000),context={id:randomUUID(),tenantId:ctx.tenantId,actorId:userId,employmentId:e.employmentId,companyId:base.companyId,deviceKeyId:keyId,installationId:key.installationId,appInstallationId:intent.appInstallationId,
 requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url'),contextDigest:'a'.repeat(64),issuerKeyId:'b'.repeat(64),policyRevision:'c'.repeat(64),contextCiphertext:'synthetic ciphertext',issuedAt,expiresAt:new Date(issuedAt.getTime()+1800000),permitCount:2};
 const permits=[1,2].map(ordinal=>({id:randomUUID(),tenantId:ctx.tenantId,actorId:userId,contextId:context.id,ordinal,nonce:randomBytes(32).toString('base64url')}));
 const input={employmentId:e.employmentId,appInstallationId:intent.appInstallationId,keyId,command:{requestId:randomUUID(),action:'out' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},evidence:{platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 const lease=()=>withTenant(ctx,async tx=>{await tx.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,keyId)).for('update');await tx.insert(S.mobileOfflineContext).values(context);await tx.insert(S.mobileOfflinePermit).values(permits);});
 const claim=(sequence=1)=>({id:randomUUID(),tenantId:ctx.tenantId,actorId:userId,employmentId:e.employmentId,deviceKeyId:keyId,contextId:context.id,permitId:permits[sequence-1].id,sequence,requestId:randomUUID(),claimDigest:(sequence===1?'d':'e').repeat(64),previousDigest:sequence===1?null:'d'.repeat(64),proofDigest:'f'.repeat(64),assertionCounter:platform==='ios'?sequence:null,
 claimCiphertext:'synthetic claim ciphertext',claimedAt:issuedAt,sampledAt:issuedAt,outcome:sequence===1?'needs_review' as const:'refused' as const,reason:sequence===1?'continuity_unknown':'policy_changed'});
 return {ctx,key,pair,context,permits,input,lease,claim};
}
async function commitClaim(f:Awaited<ReturnType<typeof fixture>>,sequence=1){
 const claim=f.claim(sequence);
 return withTenant(f.ctx,async tx=>{
  await tx.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)).for('update');
  await tx.insert(S.mobileOfflineClaim).values(claim);
  if(claim.assertionCounter!==null)await tx.update(S.mobileIntegrityKey).set({assertionCounter:claim.assertionCounter}).where(eq(S.mobileIntegrityKey.id,f.key.id));
  await tx.update(S.mobileOfflineContext).set({nextSequence:sequence+1,previousDigest:claim.claimDigest}).where(eq(S.mobileOfflineContext.id,f.context.id));
  return claim;
 });
}
describe('reserved offline stream storage and exclusion',()=>{
 it.each(['ios','android'] as const)('holds an expired %s lease without making a punch, and refuses a second lease',async platform=>{
  const f=await fixture(platform);await f.lease();
  await expect(withTenant(f.ctx,tx=>assertNoOfflineClockLeaseTx(tx,f.ctx,f.input.appInstallationId,f.key.id))).rejects.toMatchObject({reason:'offline_pending'});
  await expect(withTenant(f.ctx,async tx=>{await tx.insert(S.mobileOfflineContext).values({...f.context,id:randomUUID(),requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')});})).rejects.toThrow();
  expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
 });
 it('atomically requires complete original permit inventory and initial cursor',async()=>{
  const f=await fixture();
  for(const change of [{nextSequence:1,previousDigest:null},{nextSequence:2,previousDigest:'d'.repeat(64)}])await expect(withTenant(f.ctx,async tx=>{await tx.insert(S.mobileOfflineContext).values({...f.context,...change});await tx.insert(S.mobileOfflinePermit).values(change.nextSequence===1?f.permits.slice(0,1):f.permits);})).rejects.toThrow();
  expect(await owner.db.select().from(S.mobileOfflineContext)).toHaveLength(0);
  await f.lease();await expect(withTenant(f.ctx,tx=>tx.insert(S.mobileOfflinePermit).values({...f.permits[0],id:randomUUID(),ordinal:3,nonce:randomBytes(32).toString('base64url')}))).rejects.toThrow();
 });
 it.each(['ios','android'] as const)('commits %s review/refusal evidence and cursor together without a payable fact',async platform=>{
  const f=await fixture(platform);await f.lease();const first=await commitClaim(f);await commitClaim(f,2);
  expect(await owner.db.select().from(S.mobileOfflineClaim)).toHaveLength(2);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
  await expect(withTenant(f.ctx,tx=>tx.insert(S.mobileOfflineClaim).values({...first,id:randomUUID()}))).rejects.toThrow();
  await withTenant(f.ctx,tx=>tx.update(S.mobileOfflineContext).set({closedAt:new Date(),closeReason:'exhausted',closeRequestId:randomUUID()}).where(eq(S.mobileOfflineContext.id,f.context.id)));
  await expect(withTenant(f.ctx,tx=>assertNoOfflineClockLeaseTx(tx,f.ctx,f.input.appInstallationId,f.key.id))).resolves.toBeUndefined();
 });
 it('rolls back a claim when its cursor or Apple counter is not committed',async()=>{
  const f=await fixture();await f.lease();
  await expect(withTenant(f.ctx,tx=>tx.insert(S.mobileOfflineClaim).values(f.claim()))).rejects.toThrow();
  await expect(withTenant(f.ctx,async tx=>{const p=f.claim();await tx.insert(S.mobileOfflineClaim).values(p);await tx.update(S.mobileOfflineContext).set({nextSequence:2,previousDigest:p.claimDigest}).where(eq(S.mobileOfflineContext.id,f.context.id));})).rejects.toThrow();
  expect(await owner.db.select().from(S.mobileOfflineClaim)).toHaveLength(0);expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].assertionCounter).toBe(0);
 });
 it('refuses missing predecessor, cursor skips and premature exhaustion',async()=>{
  const f=await fixture();await f.lease();await expect(commitClaim(f,2)).rejects.toThrow();
  for(const change of [{nextSequence:2,previousDigest:'d'.repeat(64)},{closedAt:new Date(),closeReason:'exhausted' as const,closeRequestId:randomUUID()}])
   await expect(withTenant(f.ctx,tx=>tx.update(S.mobileOfflineContext).set(change).where(eq(S.mobileOfflineContext.id,f.context.id)))).rejects.toThrow();
 });
 it('blocks direct online counter updates while retaining explicit key revocation',async()=>{
  const f=await fixture();await f.lease();await expect(withTenant(f.ctx,tx=>tx.update(S.mobileIntegrityKey).set({assertionCounter:10}).where(eq(S.mobileIntegrityKey.id,f.key.id)))).rejects.toThrow();
  await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.key.id});
  await expect(withTenant(f.ctx,tx=>assertNoOfflineClockLeaseTx(tx,f.ctx,f.input.appInstallationId))).resolves.toBeUndefined();
  await expect(commitClaim(f)).rejects.toThrow();
 });
 it('keeps evidence immutable and excludes another actor from reading, inserting or taking its lease',async()=>{
  const f=await fixture(),peer=await fixture();await f.lease();const claim=await commitClaim(f);
  await withTenant(peer.ctx,async tx=>{expect(await tx.select().from(S.mobileOfflineContext)).toHaveLength(0);expect(await tx.select().from(S.mobileOfflinePermit)).toHaveLength(0);expect(await tx.select().from(S.mobileOfflineClaim)).toHaveLength(0);await assertNoOfflineClockLeaseTx(tx,peer.ctx,f.input.appInstallationId);});
  await expect(withTenant(peer.ctx,tx=>tx.insert(S.mobileOfflineClaim).values({...claim,id:randomUUID()}))).rejects.toThrow();
  await expect(withTenant(peer.ctx,tx=>tx.insert(S.mobileOfflineContext).values({...f.context,id:randomUUID(),actorId:peer.ctx.userId!,requestId:randomUUID()}))).rejects.toThrow();
  for(const statement of [sql`update mobile_offline_claim set reason='changed' where id=${claim.id}`,sql`delete from mobile_offline_claim where id=${claim.id}`,sql`update mobile_offline_permit set nonce=${randomBytes(32).toString('base64url')} where id=${f.permits[1].id}`,sql`update mobile_offline_context set context_digest=${'e'.repeat(64)} where id=${f.context.id}`])await expect(withTenant(f.ctx,tx=>tx.execute(statement))).rejects.toThrow();
 });
 it('retains a blind lease after the original employment becomes unreadable',async()=>{
  const f=await fixture();await f.lease();await owner.db.update(S.employment).set({hiredOn:'2099-01-01'}).where(eq(S.employment.id,f.input.employmentId));
  await withTenant(f.ctx,async tx=>{expect(await tx.select().from(S.mobileOfflineContext)).toHaveLength(0);await expect(assertNoOfflineClockLeaseTx(tx,f.ctx,f.input.appInstallationId)).rejects.toMatchObject({reason:'offline_pending'});});
  await expect(withTenant(f.ctx,tx=>tx.update(S.mobileIntegrityKey).set({assertionCounter:10}).where(eq(S.mobileIntegrityKey.id,f.key.id)))).rejects.toThrow();
 });
 it.each(['ios','android'] as const)('refuses the actual %s online begin/complete carrier under a lease',async platform=>{
  const f=await fixture(platform),op=vi.fn(async()=>null);
  if(platform==='ios'){
   const service=createAppleClockAssertionService(apple),begin=await service.begin(f.ctx,f.input);await f.lease();
   await expect(service.begin(f.ctx,{...f.input,command:{...f.input.command,requestId:randomUUID()}})).rejects.toMatchObject({reason:'offline_pending'});
   const auth=Buffer.alloc(37);createHash('sha256').update(apple.target.appId).digest().copy(auth);auth.writeUInt32BE(1,33);
   const nonce=createHash('sha256').update(auth).update(createHash('sha256').update(onlineClockClientData(begin.context)).digest()).digest();
   await expect(service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,f.pair.privateKey)})},op)).rejects.toMatchObject({reason:'offline_pending'});
  }else{
   const service=createAndroidClockSignatureService(android),begin=await service.begin(f.ctx,f.input);await f.lease();
   await expect(service.begin(f.ctx,{...f.input,command:{...f.input.command,requestId:randomUUID()}})).rejects.toMatchObject({reason:'offline_pending'});
   await expect(service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,signature:sign('sha256',Buffer.from(onlineClockClientData(begin.context)),f.pair.privateKey)},op)).rejects.toMatchObject({reason:'offline_pending'});
  }
  expect(op).not.toHaveBeenCalled();expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
 });
 it('allows only a durable explicit retirement to release an unexhausted stream, never reopening history',async()=>{
  const f=await fixture();await f.lease();
  await withTenant(f.ctx,tx=>tx.update(S.mobileOfflineContext).set({closedAt:new Date(),closeReason:'retired',closeRequestId:randomUUID()}).where(eq(S.mobileOfflineContext.id,f.context.id)));
  await expect(withTenant(f.ctx,tx=>assertNoOfflineClockLeaseTx(tx,f.ctx,f.input.appInstallationId,f.key.id))).resolves.toBeUndefined();
  await expect(commitClaim(f)).rejects.toThrow();
  await expect(withTenant(f.ctx,tx=>tx.update(S.mobileOfflineContext).set({closedAt:null,closeReason:null,closeRequestId:null}).where(eq(S.mobileOfflineContext.id,f.context.id)))).rejects.toThrow();
 });
 it('rechecks the lease after an actual Apple consumer waits for its key lock',async()=>{
  const f=await fixture(),service=createAppleClockAssertionService(apple),begin=await service.begin(f.ctx,f.input),op=vi.fn(async()=>null);
  const auth=Buffer.alloc(37);createHash('sha256').update(apple.target.appId).digest().copy(auth);auth.writeUInt32BE(1,33);
  const nonce=createHash('sha256').update(auth).update(createHash('sha256').update(onlineClockClientData(begin.context)).digest()).digest();
  const proof={challengeId:begin.challenge.id,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,f.pair.privateKey)})};
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const holding=withTenant(f.ctx,async tx=>{await tx.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)).for('update');entered();await held;await tx.insert(S.mobileOfflineContext).values(f.context);await tx.insert(S.mobileOfflinePermit).values(f.permits);});
  try{
   await started;const consumption=Promise.allSettled([service.consume(f.ctx,f.input,proof,op)]);
   try{
    const deadline=Date.now()+5000;let waiting=false;
    while(Date.now()<deadline){const rows=await owner.db.execute(sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%mobile_integrity_key%' and query like '%for update%'`);if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
    expect(waiting).toBe(true);
   }finally{release();}
   await holding;expect((await consumption)[0]).toMatchObject({status:'rejected',reason:{reason:'offline_pending'}});expect(op).not.toHaveBeenCalled();
   expect((await owner.db.select().from(S.mobileIntegrityChallenge).where(eq(S.mobileIntegrityChallenge.id,begin.challenge.id)))[0].consumedAt).toBeNull();
  }finally{release();await holding.catch(()=>{});}
 });
 it('refuses missing canonical captures and contradictory effective-time fields',async()=>{
  const f=await fixture();await f.lease();const p=f.claim();
  for(const change of [{outcome:'accepted' as const},{outcome:'accepted' as const,captureId:randomUUID(),effectiveAt:new Date(),effectiveMinimum:new Date(),effectiveMaximum:new Date(Date.now()+1000)},{effectiveMinimum:new Date(Date.now()+1000),effectiveMaximum:new Date()},{effectiveAt:new Date()}])
   await expect(withTenant(f.ctx,tx=>tx.insert(S.mobileOfflineClaim).values({...p,...change}))).rejects.toThrow();
  expect(await owner.db.select().from(S.mobileOfflineClaim)).toHaveLength(0);expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
 });

});
