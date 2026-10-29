/** Mounted routes, real deployment/guards/RLS/signatures/counters/canonical writes. Enrollment proof,
 * service-account RSA credentials, HTTP and bearer sessions are synthetic; no vendor is contacted. */
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import cbor from 'cbor';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import * as clockOwner from '../core/attendance-clock';
import * as credentialsOwner from '../lib/mobile-api/play-credentials';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService} from '../core/mobile-apple-enrollment';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {setAttendancePolicy} from '../packs/attendance/service';
import {onlineClockClientData,type OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';
import {AuthRequiredError} from '../lib/auth-errors';
import {todayInKualaLumpur} from '../lib/hr-date';
import {GET as iosCapabilities} from '../app/api/mobile/v2/integrity/ios/clock/capabilities/route';
import {POST as iosBegin} from '../app/api/mobile/v2/integrity/ios/clock/begin/route';
import {POST as iosComplete} from '../app/api/mobile/v2/integrity/ios/clock/complete/route';
import {GET as androidCapabilities} from '../app/api/mobile/v2/integrity/android/clock/capabilities/route';
import {POST as androidBegin} from '../app/api/mobile/v2/integrity/android/clock/begin/route';
import {POST as androidComplete} from '../app/api/mobile/v2/integrity/android/clock/complete/route';
import {GET as submissionReceipt} from '../app/api/mobile/v1/submission-receipt/route';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const ios={apiOrigin:'https://hr.example.test',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}};
const android={apiOrigin:ios.apiOrigin,target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const policy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,locationSignals:{mock:'deny_reported',simulated:'deny_reported',accessory:'allow'}};
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const credential=JSON.stringify({type:'service_account',client_email:'clock@synthetic-project.iam.gserviceaccount.com',private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()});
const handlers={ios:{capabilities:iosCapabilities,begin:iosBegin,complete:iosComplete},android:{capabilities:androidCapabilities,begin:androidBegin,complete:androidComplete}};
let base:Base,caller:SessionContext,restore:(()=>Promise<void>)|undefined,unauthenticated=false;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>{if(unauthenticated)throw new AuthRequiredError();return caller;}}));
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{await resetDb();base=await seedBase();unauthenticated=false;vi.stubEnv('AI_CONFIG_SECRET','synthetic-mounted-clock-secret');vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');vi.stubEnv('AIHR_MOBILE_ENROLLMENT_POLICY','');vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Unexpected synthetic vendor call');}));});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();await closeAll();}});
async function fixture(platform:'ios'|'android'){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Mounted signed-clock employee',primaryEmail:randomUUID()+'@mounted-clock.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};caller=ctx;
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),appInstallationId=randomUUID(),intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId};
 let keyId:string;
 if(platform==='ios'){
  const jwk=publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const enrollment=createAppleEnrollmentService(ios,{verifyProof:async()=>({publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
  const begin=await enrollment.begin(ctx,intent),key=await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId,attestation:Buffer.from('synthetic')});keyId=key.keyId;
 }else{
  const enrollment=createAndroidEnrollmentService(android,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:android.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
  const begin=await enrollment.begin(ctx,intent),key=await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:publicKey.export({type:'spki',format:'der'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]});keyId=key.keyId;
 }
 const input={appInstallationId,keyId,command:{requestId:randomUUID(),action:'in',lat:3,lng:101,accuracy:4,sampledAt:Date.now()},evidence:{platform,appId:android.target.packageName,appVersion:'1.0.3',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 const entry={tenantId:base.tenantId,companyId:base.companyId,actorIds:[ctx.userId!],legacySelfService:'require_signed',platforms:{ios:{configuration:ios},android:{configuration:{settings:android,policy},cloudProjectNumber:'123456789'}}};
 const configure=()=>vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',JSON.stringify({version:1,entries:[entry]}));
 let context!:OnlineClockIntegrityData;
 const payload=()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:android.target.packageName,requestHash:onlineClockClientDataHash(context).toString('base64url'),timestampMillis:String(Date.now())},appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:android.target.packageName,certificateSha256Digest:android.target.certificateDigests,versionCode:'4'},accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}});
 const transport=vi.fn<typeof fetch>(async url=>String(url)==='https://oauth2.googleapis.com/token'?Response.json({access_token:'synthetic-oauth-access',token_type:'Bearer',expires_in:3600}):Response.json(payload()));vi.stubGlobal('fetch',transport);
 async function call(operation:'begin'|'complete'|'capabilities',body?:unknown,query=''){
  const form=new FormData();if(body!==undefined){form.append('command',JSON.stringify(body));if(platform==='android'&&operation==='complete')form.append('playIntegrityToken','synthetic-play');}
  const response=await handlers[platform][operation](new Request('https://untrusted-host.test/api/mobile/v2/integrity/'+platform+'/clock/'+operation+'?employmentId='+e.employmentId+query,{method:operation==='capabilities'?'GET':'POST',...(operation==='capabilities'?{}:{body:form})}));return {response,body:await response.json()};
 }
 async function prepare(){
  const begin=await call('begin',input);expect(begin.body.outcome).toBe('prepared');context=begin.body.context;
  if(platform==='android')return {...input,challengeId:context.challenge.id,signature:sign('sha256',Buffer.from(onlineClockClientData(context)),privateKey).toString('base64')};
  const auth=Buffer.alloc(37);createHash('sha256').update(ios.target.appId).digest().copy(auth);auth[32]=0x40;auth.writeUInt32BE(1,33);
  const nonce=createHash('sha256').update(auth).update(onlineClockClientDataHash(context)).digest();
  return {...input,challengeId:context.challenge.id,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,privateKey)}).toString('base64')};
 }
 return {...e,ctx,input,entry,configure,transport,payload,call,prepare};
}
async function noWrites(){expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);}
describe.each(['ios','android'] as const)('%s mounted signed-clock deployment',platform=>{
 it('stays disabled without a clock rollout and issues no clock challenge or vendor request',async()=>{
  const f=await fixture(platform);
  expect((await f.call('capabilities')).body).toEqual({outcome:'unavailable',code:'not_configured'});expect((await f.call('begin',f.input)).body).toEqual({outcome:'unavailable',code:'not_configured'});
  expect(f.transport).not.toHaveBeenCalled();expect(await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.purpose,'clock.online'))).toHaveLength(0);await noWrites();
 });
 it('discovers only scoped online capability and prepares the server-origin context without a vendor request',async()=>{
  const f=await fixture(platform);f.configure();if(platform==='android')vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);
  const result=await f.call('capabilities');expect(result.response.headers.get('cache-control')).toBe('no-store');expect(result.body).toEqual({outcome:'capabilities',protocol:2,platform,commandProtocol:platform==='ios'?1:2,features:platform==='ios'?['online_clock_assertion']:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:platform==='ios'?null:'123456789'});
  const begin=await f.call('begin',f.input);expect(begin.body).toMatchObject({outcome:'prepared',protocol:platform==='ios'?1:2,context:{scope:{apiOrigin:ios.apiOrigin,actorId:f.ctx.userId,employmentId:f.employmentId}}});expect(f.transport).not.toHaveBeenCalled();await noWrites();
 });
 it('accepts one punch through the actual deployment guard and recovers concurrent exact retries',async()=>{
  const f=await fixture(platform);f.configure();if(platform==='android')vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);const proof=await f.prepare();
  const [a,b]=await Promise.all([f.call('complete',proof),f.call('complete',proof)]);expect(a.body.outcome).toBe('accepted');expect(b.body).toEqual(a.body);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
  const [key]=await owner.db.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,f.input.keyId));expect(key.assertionCounter).toBe(platform==='ios'?1:0);
  const serialized=JSON.stringify(await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent));expect(serialized).not.toMatch(/synthetic-play|synthetic-oauth-access|BEGIN PRIVATE KEY/);
  if(platform==='ios')expect(f.transport).not.toHaveBeenCalled();
 });
 it('authenticates and checks ownership before reading Google credential configuration',async()=>{
  const f=await fixture(platform);f.configure();const credentials=vi.spyOn(credentialsOwner,'readDeployedPlayCredentials');
  try{unauthenticated=true;expect((await f.call('begin',f.input)).response.status).toBe(401);unauthenticated=false;caller={...f.ctx,userId:randomUUID(),personId:randomUUID()};expect((await f.call('capabilities')).body).toEqual({outcome:'refused',code:'subject_unavailable'});expect(credentials).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();}
  finally{credentials.mockRestore();}await noWrites();
 });
 it('vetoes rollout removal after tentative work and rolls back the punch, proof counter and audit together',async()=>{
  const f=await fixture(platform);f.configure();if(platform==='android')vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);const proof=await f.prepare(),original=clockOwner.captureNativeClockInTx;
  const write=vi.spyOn(clockOwner,'captureNativeClockInTx').mockImplementationOnce(async(...args)=>{const value=await original(...args);vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');return value;});
  try{expect((await f.call('complete',proof)).body).toEqual({outcome:'unavailable',code:'not_configured'});expect(write).toHaveBeenCalledOnce();await noWrites();
   expect((await owner.db.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,f.input.keyId)))[0].assertionCounter).toBe(0);
   expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,proof.challengeId)))[0].consumedAt).toBeNull();
  }finally{write.mockRestore();}
 });
 it('keeps the dedicated committed receipt lookup working after rollout and credentials are removed',async()=>{
  const f=await fixture(platform);f.configure();if(platform==='android')vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);const proof=await f.prepare(),accepted=await f.call('complete',proof);expect(accepted.body.outcome).toBe('accepted');
  vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');vi.stubEnv('AI_CONFIG_SECRET','');f.transport.mockClear();
  const response=await submissionReceipt(new Request('https://hr.example.test/api/mobile/v1/submission-receipt?kind=clock&employmentId='+f.employmentId+'&requestId='+f.input.command.requestId));
  expect(await response.json()).toMatchObject({kind:'clock',requestId:f.input.command.requestId,receipt:accepted.body.receipt});expect(f.transport).not.toHaveBeenCalled();
 });
});
it('does not advertise or prepare Android clocking without a valid service-account configuration',async()=>{
 const f=await fixture('android');f.configure();
 for(const value of ['', '{',JSON.stringify({type:'authorized_user'})]){vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',value);expect((await f.call('capabilities')).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect((await f.call('begin',f.input)).body).toMatchObject({outcome:'unavailable',code:'configuration_unavailable'});}
 expect(f.transport).not.toHaveBeenCalled();await noWrites();
});
it('refuses OAuth outage without decoding Google evidence, consuming the challenge or creating attendance',async()=>{
 const f=await fixture('android');f.configure();vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);const proof=await f.prepare();f.transport.mockResolvedValueOnce(new Response('PRIVATE_OAUTH_ERROR',{status:503}));
 expect((await f.call('complete',proof)).body).toEqual({outcome:'unavailable',code:'proof_unavailable',integrityReason:'provider_unavailable'});expect(f.transport).toHaveBeenCalledOnce();await noWrites();
 expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,proof.challengeId)))[0].consumedAt).toBeNull();
});
it('vetoes a removed credential after Google verification rather than accepting under the prior credential snapshot',async()=>{
 const f=await fixture('android');f.configure();vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);const proof=await f.prepare(),initial=f.transport.getMockImplementation()!;
 f.transport.mockImplementation(async(...args)=>{const result=await initial(...args);if(String(args[0]).includes('decodeIntegrityToken'))vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');return result;});
 expect((await f.call('complete',proof)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});await noWrites();
});
it('recovers an exact Android committed receipt through completion without a now-missing Google provider',async()=>{
 const f=await fixture('android');f.configure();vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);const proof=await f.prepare(),accepted=await f.call('complete',proof);expect(accepted.body.outcome).toBe('accepted');
 vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');f.transport.mockClear();expect((await f.call('complete',proof)).body).toEqual(accepted.body);expect(f.transport).not.toHaveBeenCalled();
});
