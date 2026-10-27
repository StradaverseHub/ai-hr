/** Real custody/transactions/crypto. Synthetic verifier port is not Android hardware acceptance. */
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {readOwnIntegrityKeyReceipt,revokeOwnIntegrityKey} from '../core/mobile-integrity-key';
import {decryptSecret} from '../lib/ai/crypto';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let restore:(()=>Promise<void>)|undefined,base:Base;
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-android-custody-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Android enrollment',primaryEmail:randomUUID()+'@key.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 return {...e,ctx,intent:{employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()}};
}
function fixture(){
 const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=publicKey.export({type:'spki',format:'der'}),certificateChain=[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')];
 const proof={verification:'google_key_generation_proof' as const,publicKey,checkedAt:Date.now(),packageName:settings.target.packageName,versionCode:'4',securityLevel:'tee' as const,provisioning:'remote' as const,provisioningEntity:'unavailable' as const,lostDeviceStatus:'unavailable' as const,factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001};
 const verifyProof=vi.fn(async()=>({...proof,checkedAt:Date.now()})),service=createAndroidEnrollmentService(settings,{verifyProof});
 return {proof,verifyProof,service,publicKeySpki,certificateChain};
}
describe('Android enrollment custody transaction',()=>{
 it('snapshots SPKI and ordered proof bytes before asynchronous ownership/verification work',async()=>{
  const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent),spki=Buffer.from(f.publicKeySpki),chain=f.certificateChain.map(value=>Buffer.from(value));
  const input={...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain};
  const pending=f.service.complete(e.ctx,input);f.publicKeySpki.fill(0);f.certificateChain[0].fill(0);
  const accepted=await pending;expect(f.verifyProof).toHaveBeenCalledWith({publicKeySpki:spki,certificateChain:chain,challenge:Buffer.from(begin.clientDataHash,'base64')},undefined);
  expect(await f.service.complete(e.ctx,{...input,publicKeySpki:spki,certificateChain:chain})).toEqual(accepted);expect(f.verifyProof).toHaveBeenCalledOnce();
 });
 it('refuses an owner offboarded during verification without consuming or registering anything',async()=>{
  const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent);
  f.verifyProof.mockImplementationOnce(async()=>{
   await owner.db.update(schema.employment).set({hiredOn:'2099-01-01'}).where(eq(schema.employment.id,e.employmentId));return {...f.proof,checkedAt:Date.now()};
  });
  await expect(f.service.complete(e.ctx,{...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain})).rejects.toThrow();
  expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
  expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,begin.challenge.id)))[0].consumedAt).toBeNull();
 });
 it('rolls back consumption if employment becomes ineligible while waiting for the custody actor lock',async()=>{
  const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const holding=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${e.ctx.tenantId+':mobile-integrity:'+e.ctx.userId},0))`);entered();await held;});
  try{
   await started;const outcome=Promise.allSettled([f.service.complete(e.ctx,{...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain})]);
   try{
    const deadline=Date.now()+5000;let waiting=false;
    while(Date.now()<deadline){
     const rows=await owner.db.execute(sql`select query from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'`);
     if(rows.some(row=>String(row.query).includes('pg_advisory_xact_lock'))){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(waiting).toBe(true);await owner.db.update(schema.employment).set({hiredOn:'2099-01-01'}).where(eq(schema.employment.id,e.employmentId));
   }finally{release();}
   await holding;expect((await outcome)[0].status).toBe('rejected');
   expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
   expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,begin.challenge.id)))[0].consumedAt).toBeNull();
  }finally{release();await holding.catch(()=>{});}
 });
 it('binds verification to the original server digest and atomically stores encrypted provenance once',async()=>{
  const e=await employee(),f=fixture(),prepared=await f.service.begin(e.ctx,e.intent),input={...e.intent,challengeId:prepared.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain};
  const [a,b]=await Promise.all([f.service.complete(e.ctx,input),f.service.complete(e.ctx,input)]);expect(a).toEqual(b);
  expect(f.verifyProof).toHaveBeenCalledWith({publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain,challenge:Buffer.from(prepared.clientDataHash,'base64')},undefined);
  const [row]=await owner.db.select().from(schema.mobileIntegrityKey);expect(row.platform).toBe('android');expect(row.environment).toBeNull();expect(row.assertionCounter).toBe(0);
  expect(row.publicKeySpki).toEqual(f.publicKeySpki);expect(row.metadata).toMatchObject({androidKeyGeneration:{version:1,versionCode:'4',securityLevel:'tee'}});
  const aad=JSON.stringify(['mobile-integrity-key-receipt',1,base.tenantId,e.ctx.userId,row.id,prepared.challenge.id]);
  expect(JSON.parse(decryptSecret(row.receiptCiphertext,aad))).toEqual(['aihr.android.key.provenance',1,prepared.context,['aihr.android.enrollment.proof',1,f.publicKeySpki.toString('base64'),f.certificateChain.map(value=>value.toString('base64'))]]);
  expect(()=>decryptSecret(row.receiptCiphertext,aad+'wrong')).toThrow();
  expect(a).toMatchObject({platform:'android',proofKind:'google_key_generation_proof',environment:null});expect(a).not.toHaveProperty('metadata');expect(a).not.toHaveProperty('vendorKeyId');
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,row.id));expect(events.filter(event=>event.eventType==='mobile.integrity.key.enrolled')).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain('synthetic leaf');
 });
 it('recovers before re-verification or secret availability and preserves revoked history',async()=>{
  const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent),input={...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain};
  const accepted=await f.service.complete(e.ctx,input);f.verifyProof.mockRejectedValue(new Error('must not repeat accepted proof'));
  vi.stubEnv('AI_CONFIG_SECRET','');expect(await f.service.complete(e.ctx,input)).toEqual(accepted);
  await expect(f.service.complete(e.ctx,{...input,certificateChain:[Buffer.from('different leaf'),f.certificateChain[1]]})).rejects.toMatchObject({reason:'binding_conflict'});
  const revoked=await revokeOwnIntegrityKey(e.ctx,{employmentId:e.employmentId,keyId:accepted.keyId});expect(await f.service.complete(e.ctx,input)).toEqual(revoked);
  expect(await readOwnIntegrityKeyReceipt(e.ctx,{employmentId:e.employmentId,originChallengeId:begin.challenge.id})).toEqual(revoked);expect(f.verifyProof).toHaveBeenCalledOnce();
 });
 it('refuses invalid/unavailable proofs and cancellation without consuming the challenge',async()=>{
  const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent),input={...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain};
  f.verifyProof.mockRejectedValueOnce(new Error('status unavailable'));await expect(f.service.complete(e.ctx,input)).rejects.toThrow('status unavailable');
  const controller=new AbortController();controller.abort();await expect(f.service.complete(e.ctx,input,controller.signal)).rejects.toMatchObject({reason:'key_unavailable'});
  const other=fixture();f.proof.publicKey=other.proof.publicKey;await expect(f.service.complete(e.ctx,input)).rejects.toMatchObject({reason:'invalid_proof'});
  expect((await f.service.begin(e.ctx,e.intent)).challenge.state).toBe('active');expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
 });
 it('rolls back duplicate public-key registration and does not adopt a revoked fingerprint',async()=>{
  const e=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent),input={...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain};
  const first=await f.service.complete(e.ctx,input);await revokeOwnIntegrityKey(e.ctx,{employmentId:e.employmentId,keyId:first.keyId});
  const next={...e.intent,requestId:randomUUID()},fresh=await f.service.begin(e.ctx,next);
  await expect(f.service.complete(e.ctx,{...input,...next,challengeId:fresh.challenge.id})).rejects.toMatchObject({reason:'key_unavailable'});
  expect((await f.service.begin(e.ctx,next)).challenge.state).toBe('active');expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(1);
 });
 it('refuses peers, archived owners and oversized proofs before any verifier invocation',async()=>{
  const e=await employee(),peer=await employee(),f=fixture(),begin=await f.service.begin(e.ctx,e.intent),input={...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain};
  await expect(f.service.complete(peer.ctx,input)).rejects.toThrow();
  await expect(f.service.complete(e.ctx,{...input,certificateChain:[Buffer.alloc(16384),Buffer.alloc(16384)]})).rejects.toMatchObject({reason:'invalid_proof'});
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));await expect(f.service.complete(e.ctx,input)).rejects.toThrow();expect(f.verifyProof).not.toHaveBeenCalled();
 });
 it('uses the real verifier by default and never treats a prepared challenge as an enrolled key',async()=>{
  const e=await employee(),service=createAndroidEnrollmentService(settings),f=fixture(),begin=await service.begin(e.ctx,e.intent);
  await expect(service.complete(e.ctx,{...e.intent,challengeId:begin.challenge.id,publicKeySpki:f.publicKeySpki,certificateChain:f.certificateChain})).rejects.toThrow();
  expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);expect((await service.begin(e.ctx,e.intent)).challenge.state).toBe('active');
 });
});
