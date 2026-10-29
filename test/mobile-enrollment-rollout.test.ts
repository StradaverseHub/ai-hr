/** Mounted routes, actual deployment reader/catalog checks and real authorization. Seeded proofs
 * are synthetic and cannot substantiate supported-device attestation. No shared migration apply. */
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService} from '../core/mobile-apple-enrollment';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import * as appleOwner from '../core/mobile-apple-enrollment';
import * as androidOwner from '../core/mobile-android-enrollment';
import {AuthRequiredError} from '../lib/auth-errors';
import {GET as iosCapabilities} from '../app/api/mobile/v2/integrity/ios/capabilities/route';
import {GET as androidCapabilities} from '../app/api/mobile/v2/integrity/android/capabilities/route';
import {POST as iosBegin} from '../app/api/mobile/v1/integrity/enrollment/begin/route';
import {POST as iosComplete} from '../app/api/mobile/v1/integrity/enrollment/complete/route';
import {POST as androidBegin} from '../app/api/mobile/v2/integrity/android/enrollment/begin/route';
import {POST as androidComplete} from '../app/api/mobile/v2/integrity/android/enrollment/complete/route';
import {POST as keyReceipt} from '../app/api/mobile/v2/integrity/key-receipt/route';
import {POST as revokeKey} from '../app/api/mobile/v2/integrity/revoke/route';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const ios={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}};
const android={apiOrigin:ios.apiOrigin,target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let base:Base,caller:SessionContext,unauthorized=false,restore:(()=>Promise<void>)|undefined;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>{if(unauthorized)throw new AuthRequiredError();return caller;}}));
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{await resetDb();base=await seedBase();unauthorized=false;vi.stubEnv('AI_CONFIG_SECRET','synthetic-enrollment-rollout-secret');vi.stubEnv('AIHR_MOBILE_ENROLLMENT_POLICY','');});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Scoped rollout',primaryEmail:randomUUID()+'@rollout.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 return {...e,ctx,intent:{requestId:randomUUID(),appInstallationId:randomUUID()}};
}
function entry(platform:'ios'|'android',e:Awaited<ReturnType<typeof employee>>){return {tenantId:base.tenantId,companyId:base.companyId,actorIds:[e.ctx.userId!],settings:platform==='ios'?ios:android};}
function configure(entries:unknown[]){vi.stubEnv('AIHR_MOBILE_ENROLLMENT_POLICY',JSON.stringify({version:1,entries}));}
async function call(handler:(r:Request)=>Promise<Response>,id:string,body?:unknown){
 const response=await handler(new Request('https://untrusted-host.example/api/mobile/integrity?employmentId='+id,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}));
 return {response,body:await response.json()};
}
describe.each(['ios','android'] as const)('%s deployment-owned enrollment rollout',platform=>{
 const capabilities=platform==='ios'?iosCapabilities:androidCapabilities,begin=platform==='ios'?iosBegin:androidBegin,complete=platform==='ios'?iosComplete:androidComplete;
 it('is disabled by default across discovery and preparation, with no issued challenge',async()=>{
  const e=await employee();caller=e.ctx;
  expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  expect((await call(begin,e.employmentId,e.intent)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('advertises enrollment only and reconstructs preparation from the scoped server policy',async()=>{
  const e=await employee();caller=e.ctx;configure([entry(platform,e)]);
  const result=await call(capabilities,e.employmentId);expect(result.response.status).toBe(200);expect(result.response.headers.get('cache-control')).toBe('no-store');
  expect(result.body).toEqual({outcome:'capabilities',protocol:2,platform,features:['key_enrollment'],offline:false});
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
  const prepared=await call(begin,e.employmentId,e.intent);expect(prepared.body).toMatchObject({outcome:'prepared',protocol:platform==='ios'?1:2,context:{apiOrigin:ios.apiOrigin,actorId:e.ctx.userId,employmentId:e.employmentId,target:platform==='ios'?ios.target:android.target}});
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(1);expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
 });
 it('requires an exact tenant/company/actor/platform allowlist and reads it afresh',async()=>{
  const e=await employee();caller=e.ctx;const selected=entry(platform,e);
  for(const changed of [{...selected,tenantId:randomUUID()},{...selected,companyId:randomUUID()},{...selected,actorIds:[randomUUID()]},{...selected,settings:platform==='ios'?android:ios}]){
   configure([changed]);expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  }
  configure([selected]);expect((await call(capabilities,e.employmentId)).body.outcome).toBe('capabilities');
  configure([]);expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('rejects malformed, oversized and duplicate policy instead of silently selecting one entry',async()=>{
  const e=await employee();caller=e.ctx;const selected=entry(platform,e);
  for(const value of ['{','x'.repeat(262145),JSON.stringify({version:1,entries:[selected,selected]}),JSON.stringify({version:1,entries:[{...selected,actorIds:[]}]}),JSON.stringify({version:1,entries:[{...selected,actorIds:[e.ctx.userId,e.ctx.userId]}]})]){
   vi.stubEnv('AIHR_MOBILE_ENROLLMENT_POLICY',value);expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  }
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('does not expose another subject or fall back to an unproven current-company column',async()=>{
  const e=await employee(),peer=await employee();configure([entry(platform,e)]);caller=peer.ctx;
  expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  caller=adminCtx(base);expect((await call(begin,e.employmentId,e.intent)).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  caller=e.ctx;await owner.db.update(schema.assignment).set({validTo:'2024-12-31'}).where(eq(schema.assignment.employmentId,e.employmentId));
  expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  unauthorized=true;expect((await call(capabilities,e.employmentId)).response.status).toBe(401);
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('does not advertise readiness with missing receipt encryption or a disabled custody trigger',async()=>{
  const e=await employee();caller=e.ctx;configure([entry(platform,e)]);
  vi.stubEnv('AI_CONFIG_SECRET','');expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  vi.stubEnv('AI_CONFIG_SECRET','synthetic-enrollment-rollout-secret');
  await owner.db.execute(sql`ALTER TABLE mobile_integrity_key DISABLE TRIGGER mobile_integrity_key_immutable`);
  try{expect((await call(capabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});}
  finally{await owner.db.execute(sql`ALTER TABLE mobile_integrity_key ENABLE TRIGGER mobile_integrity_key_immutable`);}
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
});
it('requires the actual paired Android custody constraint while preserving iPhone discovery',async()=>{
 const e=await employee();caller=e.ctx;configure([entry('ios',e),entry('android',e)]);
 const [constraint]=await owner.db.execute(sql`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='mobile_integrity_key'::regclass AND conname='mobile_integrity_key_platform_evidence_check'`);expect(constraint).toBeTruthy();
 await owner.db.execute(sql`ALTER TABLE mobile_integrity_key DROP CONSTRAINT mobile_integrity_key_platform_evidence_check`);
 try{
  expect((await call(androidCapabilities,e.employmentId)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  expect((await call(androidBegin,e.employmentId,e.intent)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  expect((await call(iosCapabilities,e.employmentId)).body.outcome).toBe('capabilities');
 }finally{await owner.db.execute(sql.raw('ALTER TABLE mobile_integrity_key ADD CONSTRAINT mobile_integrity_key_platform_evidence_check '+String(constraint.definition)));}
 expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
});
it.each(['ios','android'] as const)('reconciles an exact accepted %s proof through its mounted command and keeps recovery after rollout removal',async(platform)=>{
 const e=await employee();caller=e.ctx;configure([entry(platform,e)]);const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 let key:unknown,proof:unknown,challengeId:string;
 if(platform==='ios'){
  const jwk=publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64'),attestation=Buffer.from('synthetic proof');
  const service=createAppleEnrollmentService(ios,{verifyProof:async()=>({publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
  const begin=await service.begin(e.ctx,{...e.intent,employmentId:e.employmentId});challengeId=begin.context.challengeId;
  key=await service.complete(e.ctx,{...e.intent,employmentId:e.employmentId,challengeId,vendorKeyId,attestation});proof={...e.intent,challengeId,vendorKeyId,attestation:attestation.toString('base64')};
 }else{
  const publicKeySpki=publicKey.export({type:'spki',format:'der'}),certificateChain=[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')];
  const service=createAndroidEnrollmentService(android,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:android.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
  const begin=await service.begin(e.ctx,{...e.intent,employmentId:e.employmentId});challengeId=begin.context.challengeId;
  key=await service.complete(e.ctx,{...e.intent,employmentId:e.employmentId,challengeId,publicKeySpki,certificateChain});proof={...e.intent,challengeId,publicKeySpki:publicKeySpki.toString('base64'),certificateChain:certificateChain.map(value=>value.toString('base64'))};
 }
 const handler=platform==='ios'?iosComplete:androidComplete;
 expect((await call(handler,e.employmentId,proof)).body).toEqual({outcome:'enrolled',key});
 configure([]);expect((await call(handler,e.employmentId,proof)).body).toEqual({outcome:'unavailable',code:'not_configured'});
 vi.stubEnv('AI_CONFIG_SECRET','');const receipt=await call(keyReceipt,e.employmentId,{originChallengeId:challengeId});expect(receipt.body).toEqual({outcome:'key_receipt',key});
 const revoked=await call(revokeKey,e.employmentId,{keyId:receipt.body.key.keyId});expect(revoked.body).toMatchObject({outcome:'revoked',key:{originChallengeId:challengeId}});expect(revoked.body.key.revokedAt).not.toBeNull();
 expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(1);
});
it.each([['ios','remove'],['android','remove'],['ios','target'],['android','target']] as const)('rolls back %s custody if rollout %s changes during vendor verification',async(platform,change)=>{
 const e=await employee();caller=e.ctx;configure([entry(platform,e)]);
 const begin=await call(platform==='ios'?iosBegin:androidBegin,e.employmentId,e.intent);expect(begin.body.outcome).toBe('prepared');
 const challengeId=begin.body.context.challengeId,{publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 let first=true,restoreVerifier=()=>{},proof:unknown;
 const changePolicy=()=>{
  if(!first)return;first=false;
  if(change==='remove')configure([]);
  else {const original=entry(platform,e);configure([{...original,settings:platform==='ios'?{...ios,target:{...ios.target,requiredMetadata:{validationCategory:4,bundleVersions:['5']}}}:{...android,target:{...android.target,versionCodes:['5']}}}]);}
 };
 if(platform==='ios'){
  const jwk=publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const original=appleOwner.createAppleEnrollmentService;
  const spy=vi.spyOn(appleOwner,'createAppleEnrollmentService').mockImplementation((settings,ports={})=>original(settings,{...ports,verifyProof:async()=>{
   changePolicy();return {publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'};
  }}));restoreVerifier=()=>{spy.mockRestore();};
  proof={...e.intent,challengeId,vendorKeyId,attestation:Buffer.from('synthetic').toString('base64')};
 }else{
  const original=androidOwner.createAndroidEnrollmentService;
  const spy=vi.spyOn(androidOwner,'createAndroidEnrollmentService').mockImplementation((settings,ports={})=>original(settings,{...ports,verifyProof:async()=>{
   changePolicy();return {verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:android.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001};
  }}));restoreVerifier=()=>{spy.mockRestore();};
  proof={...e.intent,challengeId,publicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),certificateChain:[Buffer.from('synthetic leaf').toString('base64'),Buffer.from('synthetic issuer').toString('base64')]};
 }
 try{
  const complete=platform==='ios'?iosComplete:androidComplete;
  expect((await call(complete,e.employmentId,proof)).body).toEqual({outcome:'unavailable',code:change==='remove'?'not_configured':'configuration_unavailable'});
  expect((await owner.db.select().from(schema.mobileIntegrityChallenge))[0].consumedAt).toBeNull();expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
  expect((await owner.db.select().from(schema.domainEvent)).some(event=>event.eventType==='mobile.integrity.key.enrolled'||event.eventType==='mobile.integrity.challenge.consumed')).toBe(false);
  configure([entry(platform,e)]);expect((await call(complete,e.employmentId,proof)).body.outcome).toBe('enrolled');
  expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(1);
 }finally{restoreVerifier();}
});
