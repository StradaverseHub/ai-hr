/** Actual HTTP/auth/body/challenge/custody boundaries. Only seed proof and bearer resolution are
 * synthetic; production handlers have no verifier override and reject that same seed proof. */
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {createAndroidEnrollmentHttpHandlers} from '../lib/mobile-api/android-enrollment-routes';
import {AuthRequiredError} from '../lib/auth-errors';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let restore:(()=>Promise<void>)|undefined,base:Base,caller:SessionContext,config:unknown|null,unauthorized=false;
const configuration=vi.fn(async(_ctx:SessionContext,_employmentId:string,_signal:AbortSignal)=>config);
const resolve=async()=>{if(unauthorized)throw new AuthRequiredError();return caller;};
const api=createAndroidEnrollmentHttpHandlers(configuration,resolve);
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-android-http-secret-2026');await resetDb();base=await seedBase();config=settings;unauthorized=false;configuration.mockClear();});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Android HTTP',primaryEmail:randomUUID()+'@http.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 return {...e,ctx,intent:{requestId:randomUUID(),appInstallationId:randomUUID()}};
}
function request(kind:keyof typeof api,id:string,body:unknown,extra=''){
 return new Request('https://phone-controlled.example/api/mobile/v2/integrity/'+kind+'?employmentId='+id+extra,{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body:JSON.stringify(body)});
}
async function call(kind:keyof typeof api,id:string,body:unknown,extra=''){
 const response=await api[kind](request(kind,id,body,extra));return {response,body:await response.json()};
}
describe('unmounted Android enrollment HTTP integration',()=>{
 it('derives authority from the session/server and returns the exact preparation on retry',async()=>{
  const e=await employee();caller=e.ctx;
  const a=await call('enrollmentBegin',e.employmentId,e.intent),b=await call('enrollmentBegin',e.employmentId,e.intent);
  expect(a.response.status).toBe(200);expect(a.response.headers.get('cache-control')).toBe('no-store');expect(b.body).toEqual(a.body);
  expect(a.body).toMatchObject({outcome:'prepared',protocol:2,state:'active',context:{apiOrigin:settings.apiOrigin,actorId:e.ctx.userId,employmentId:e.employmentId,target:settings.target}});
  expect(a.body).not.toHaveProperty('bindingHash');expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(1);
  expect(configuration.mock.calls.every(([ctx,id])=>ctx===caller&&id===e.employmentId)).toBe(true);
 });
 it('authorizes the exact own subject before reading configuration or creating a challenge',async()=>{
  const e=await employee(),peer=await employee();caller=peer.ctx;
  expect((await call('enrollmentBegin',e.employmentId,e.intent)).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  caller=adminCtx(base);expect((await call('enrollmentBegin',e.employmentId,e.intent)).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  caller=e.ctx;unauthorized=true;expect((await call('enrollmentBegin',e.employmentId,e.intent)).response.status).toBe(401);
  expect(configuration).not.toHaveBeenCalled();expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('rejects injected authority, duplicate selectors, noncanonical proofs and forged lengths',async()=>{
  const e=await employee();caller=e.ctx;
  for(const extra of [{actorId:e.ctx.userId},{target:settings.target},{verified:true}])expect((await call('enrollmentBegin',e.employmentId,{...e.intent,...extra})).response.status).toBe(400);
  expect((await call('enrollmentBegin',e.employmentId,e.intent,'&employmentId='+e.employmentId)).response.status).toBe(400);
  expect((await call('enrollmentBegin',e.employmentId,{...e.intent,padding:'x'.repeat(2048)})).response.status).toBe(400);
  const proof={...e.intent,challengeId:randomUUID(),publicKeySpki:Buffer.alloc(91).toString('base64'),certificateChain:['eA==','eQ==']};
  expect((await call('enrollmentComplete',e.employmentId,{...proof,publicKeySpki:proof.publicKeySpki+'\n'})).response.status).toBe(400);
  expect((await call('enrollmentComplete',e.employmentId,{...proof,certificateChain:Array(8).fill(Buffer.alloc(16384).toString('base64'))})).response.status).toBe(400);
  expect(configuration).not.toHaveBeenCalled();expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
 });
 it('keeps missing and malformed deployment policy unavailable without creating a challenge',async()=>{
  const e=await employee();caller=e.ctx;
  config=null;expect((await call('enrollmentBegin',e.employmentId,e.intent)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  config={...settings,target:{...settings.target,platform:'ios'}};expect((await call('enrollmentBegin',e.employmentId,e.intent)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('times out configuration and prevents late completion from creating a challenge',async()=>{
  const e=await employee();caller=e.ctx;let finish!:(value:unknown)=>void,signal:AbortSignal|undefined;
  const slow=vi.fn(async(_ctx:SessionContext,_id:string,s:AbortSignal)=>{signal=s;return new Promise<unknown>(resolve=>{finish=resolve;});});
  const bounded=createAndroidEnrollmentHttpHandlers(slow,resolve,{configurationTimeoutMs:10});
  const response=await bounded.enrollmentBegin(request('enrollmentBegin',e.employmentId,e.intent));
  expect(await response.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect(signal?.aborted).toBe(true);
  finish(settings);await new Promise(resolve=>setTimeout(resolve,20));expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
 });
 it('uses real proof validation and leaves an invalid proof unconsumed without private diagnostics',async()=>{
  const e=await employee();caller=e.ctx;const prepared=await call('enrollmentBegin',e.employmentId,e.intent);
  const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const result=await call('enrollmentComplete',e.employmentId,{...e.intent,challengeId:prepared.body.context.challengeId,publicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),certificateChain:['eA==','eQ==']});
  expect(result.response.status).toBe(200);expect(result.body).toEqual({outcome:'refused',code:'invalid_proof'});
  expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);expect((await owner.db.select().from(schema.mobileIntegrityChallenge))[0].consumedAt).toBeNull();
 });
 it('recovers the exact previously accepted proof before re-verifying it, without exposing provenance',async()=>{
  const e=await employee();caller=e.ctx;const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({type:'spki',format:'der'}),chain=[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')];
  const service=createAndroidEnrollmentService(settings,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:settings.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
  const begin=await service.begin(e.ctx,{...e.intent,employmentId:e.employmentId}),key=await service.complete(e.ctx,{...e.intent,employmentId:e.employmentId,challengeId:begin.context.challengeId,publicKeySpki:spki,certificateChain:chain});
  const body={...e.intent,challengeId:begin.context.challengeId,publicKeySpki:spki.toString('base64'),certificateChain:chain.map(value=>value.toString('base64'))};
  vi.stubEnv('AI_CONFIG_SECRET','');
  const recovered=await call('enrollmentComplete',e.employmentId,body);expect(recovered.body).toEqual({outcome:'enrolled',key});
  expect(Object.keys(recovered.body.key).sort()).toEqual(['keyId','originChallengeId','platform','appId','environment','proofKind','nativeKeyBinding','createdAt','revokedAt'].sort());
  expect((await call('enrollmentComplete',e.employmentId,{...body,certificateChain:['eg==','eQ==']})).body).toEqual({outcome:'refused',code:'binding_conflict'});
  expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(1);
 });
});
