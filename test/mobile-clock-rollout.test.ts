/** Actual deployment policy, temporal ownership, shared web/native writer and signed HTTP transaction.
 * Enrollment provenance, Google HTTP and session resolution are synthetic; no rollout is activated. */
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as attendanceOwner from '../core/attendance';
import {captureEmployeeClock,captureNativeClock,ClockIntegrityRequiredError} from '../packs/attendance/service';
import {setAttendancePolicy} from '../packs/attendance/service';
import {readMobileClockConfiguration,readMobileClockDeployment,assertMobileClockCommit} from '../packs/attendance/mobile-integrity';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {hireEmployee} from '../core/org';
import {AuthRequiredError} from '../lib/auth-errors';
import {IntegrityConfigurationUnavailable} from '../lib/mobile-api/integrity-configuration';
import {createSignedClockHttpHandlers} from '../lib/mobile-api/signed-clock-routes';
import {onlineClockClientData} from '../lib/mobile-clock-integrity';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';
import {clockCommandContext} from '../lib/clock-command-context';
import {todayInKualaLumpur} from '../lib/hr-date';
import {POST as legacyMobile} from '../app/api/mobile/v1/clock/route';
import {POST as legacyWeb} from '../app/api/attendance/clock/route';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const ios={apiOrigin:'https://hr.example.test',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}};
const android={apiOrigin:ios.apiOrigin,target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const policy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,locationSignals:{mock:'deny_reported',simulated:'deny_reported',accessory:'allow'}};
const androidConfig={settings:android,policy};
let base:Base,caller:SessionContext,restore:(()=>Promise<void>)|undefined,unauthenticated=false;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>{if(unauthenticated)throw new AuthRequiredError();return caller;}}));
vi.mock('../lib/attendance-clock-session',()=>({clockApiSession:async()=>unauthenticated?null:caller}));
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{await resetDb();base=await seedBase();unauthenticated=false;vi.stubEnv('AI_CONFIG_SECRET','synthetic-clock-rollout-secret');vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');vi.stubEnv('AIHR_MOBILE_ENROLLMENT_POLICY','');});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Clock rollout employee',primaryEmail:randomUUID()+'@clock-rollout.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 caller=ctx;await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 const command={action:'in' as const,requestId:randomUUID(),lat:3,lng:101,accuracy:4,sampledAt:Date.now()};
 return {...e,ctx,command};
}
type Employee=Awaited<ReturnType<typeof employee>>;
function entry(e:Employee,legacySelfService:'allow_unverified'|'require_signed'='require_signed'){
 return {tenantId:base.tenantId,companyId:base.companyId,actorIds:[e.ctx.userId!],legacySelfService,
  platforms:{ios:{configuration:ios},android:{configuration:androidConfig,cloudProjectNumber:'123456789'}}};
}
function configure(entries:unknown[]){vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',JSON.stringify({version:1,entries}));}
const signal=()=>new AbortController().signal;
async function noWrites(){expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.captured'))).toHaveLength(0);}
function webInput(e:Employee){return {...e.command,employmentId:e.employmentId,clockContext:clockCommandContext(e.ctx.tenantId,e.ctx.userId,e.employmentId)};}
async function legacy(e:Employee,platform:'web'|'mobile',command=e.command){
 const form=new FormData();
 if(platform==='mobile')form.append('command',JSON.stringify(command));
 else for(const [key,value]of Object.entries({...webInput(e),...command})){if(key!=='sampledAt')form.append(key,String(value));}
 const response=await(platform==='mobile'?legacyMobile:legacyWeb)(new Request('https://hr.example.test/api/'+(platform==='mobile'?'mobile/v1/clock?employmentId='+e.employmentId:'attendance/clock'),{method:'POST',headers:{origin:'https://hr.example.test'},body:form}));
 return {response,body:await response.json()};
}
async function signed(e:Employee){
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),appInstallationId=randomUUID();
 const enrollment=createAndroidEnrollmentService(android,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:android.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId},begin=await enrollment.begin(e.ctx,intent);
 const key=await enrollment.complete(e.ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:publicKey.export({type:'spki',format:'der'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]});
 let context!:Parameters<typeof onlineClockClientDataHash>[0];
 const value=()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:android.target.packageName,requestHash:onlineClockClientDataHash(context).toString('base64url'),timestampMillis:String(Date.now())},appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:android.target.packageName,certificateSha256Digest:android.target.certificateDigests,versionCode:'4'},accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}});
 const transport=vi.fn<typeof fetch>(async()=>Response.json(value()));
 const api=createSignedClockHttpHandlers('android',(ctx,id,abort)=>readMobileClockConfiguration('android',ctx,id,abort),async()=>e.ctx,{beforeClockCommit:assertMobileClockCommit,androidPlay:{accessToken:async()=> 'synthetic-server-access',transport}});
 const input={appInstallationId,keyId:key.keyId,command:e.command,evidence:{platform:'android',appId:android.target.packageName,appVersion:'1.0.3',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 const request=(body:unknown,token=false)=>{const form=new FormData();form.append('command',JSON.stringify(body));if(token)form.append('playIntegrityToken','synthetic-play');return new Request('https://untrusted-host.test/clock?employmentId='+e.employmentId,{method:'POST',body:form});};
 const prepared=await(await api.clockBegin(request(input))).json();expect(prepared.outcome).toBe('prepared');context=prepared.context;
 const proof={...input,challengeId:prepared.context.challenge.id,signature:sign('sha256',Buffer.from(onlineClockClientData(context)),privateKey).toString('base64')};
 return {transport,value,complete:()=>api.clockComplete(request(proof,true)),challengeId:proof.challengeId};
}
describe('separate deployment-owned clock rollout and legacy self-service policy',()=>{
 it('keeps signed clocking disabled by default even if enrollment is allowed',async()=>{
  const e=await employee();vi.stubEnv('AIHR_MOBILE_ENROLLMENT_POLICY',JSON.stringify({version:1,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[e.ctx.userId],settings:android}]}));
  for(const platform of ['ios','android'] as const)expect(await readMobileClockConfiguration(platform,e.ctx,e.employmentId,signal())).toBeNull();
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
  expect((await legacy(e,'mobile')).body.outcome).toBe('accepted');
 });
 it('reads exact actor/tenant/proven-company/platform entries and exposes only trusted SDK project configuration',async()=>{
  const e=await employee(),selected=entry(e);
  for(const change of [{...selected,tenantId:randomUUID()},{...selected,companyId:randomUUID()},{...selected,actorIds:[randomUUID()]},{...selected,platforms:{...selected.platforms,android:null}}]){
   configure([change]);expect(await readMobileClockConfiguration('android',e.ctx,e.employmentId,signal())).toBeNull();
  }
  configure([selected]);expect(await readMobileClockConfiguration('ios',e.ctx,e.employmentId,signal())).toEqual(ios);
  expect(await readMobileClockDeployment('android',e.ctx,e.employmentId,signal())).toEqual({configuration:androidConfig,cloudProjectNumber:'123456789'});
  configure([]);expect(await readMobileClockConfiguration('ios',e.ctx,e.employmentId,signal())).toBeNull();await noWrites();
 });
 it('refuses malformed, oversized, duplicate and incomplete policy rather than granting a fallback',async()=>{
  const e=await employee(),selected=entry(e);
  for(const raw of ['{','x'.repeat(262145),JSON.stringify({version:1,entries:[selected,selected]}),JSON.stringify({version:1,entries:[{...selected,legacySelfService:undefined}]}),JSON.stringify({version:1,entries:[{...selected,actorIds:[e.ctx.userId,e.ctx.userId]}]}),JSON.stringify({version:1,entries:[{...selected,platforms:{ios:null,android:null}}]}),JSON.stringify({version:1,entries:[{...selected,platforms:{ios:null,android:{configuration:androidConfig,cloudProjectNumber:'0'}}}]})]){
   vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',raw);
   await expect(readMobileClockConfiguration('android',e.ctx,e.employmentId,signal())).rejects.toBeInstanceOf(IntegrityConfigurationUnavailable);
   const result=await legacy(e,'mobile');expect(result.response.status).toBe(503);expect(result.body).toEqual({error:'unavailable'});
  }await noWrites();
 });
 it.each([{label:'letters',value:'abc'},{label:'trailing newline',value:'123\n'},{label:'integer overflow',value:'9223372036854775808'},{label:'oversized digits',value:'1'.repeat(10000)}])('refuses malformed project number $label through typed configuration outcomes',async({value:cloudProjectNumber})=>{
  const e=await employee(),selected=entry(e);configure([{...selected,platforms:{ios:null,android:{configuration:androidConfig,cloudProjectNumber}}}]);
  await expect(readMobileClockDeployment('android',e.ctx,e.employmentId,signal())).rejects.toBeInstanceOf(IntegrityConfigurationUnavailable);
  const response=await legacy(e,'mobile');expect(response.response.status).toBe(503);expect(response.body).toEqual({error:'unavailable'});await noWrites();
 });
 it('does not use an unproven current-company column or another actor to select a rollout',async()=>{
  const e=await employee(),peer=await employee();configure([entry(e)]);
  await expect(readMobileClockConfiguration('android',peer.ctx,e.employmentId,signal())).rejects.toThrow();
  await owner.db.update(schema.assignment).set({validFrom:todayInKualaLumpur(new Date(Date.now()+86400000))}).where(eq(schema.assignment.employmentId,e.employmentId));
  expect(await readMobileClockConfiguration('android',e.ctx,e.employmentId,signal())).toBeNull();await noWrites();
 });
 it('checks cancellation, receipt encryption and existing custody readiness without migration credentials',async()=>{
  const e=await employee();configure([entry(e)]);const abort=new AbortController();abort.abort();
  await expect(readMobileClockConfiguration('ios',e.ctx,e.employmentId,abort.signal)).rejects.toBeInstanceOf(IntegrityConfigurationUnavailable);
  vi.stubEnv('AI_CONFIG_SECRET','');await expect(readMobileClockConfiguration('ios',e.ctx,e.employmentId,signal())).rejects.toBeInstanceOf(IntegrityConfigurationUnavailable);
  vi.stubEnv('AI_CONFIG_SECRET','synthetic-clock-rollout-secret');await owner.db.execute(sql`ALTER TABLE mobile_integrity_key DISABLE TRIGGER mobile_integrity_key_immutable`);
  try{await expect(readMobileClockConfiguration('android',e.ctx,e.employmentId,signal())).rejects.toBeInstanceOf(IntegrityConfigurationUnavailable);}
  finally{await owner.db.execute(sql`ALTER TABLE mobile_integrity_key ENABLE TRIGGER mobile_integrity_key_immutable`);}await noWrites();
 });
 it.each(['web','mobile'] as const)('blocks new unsigned %s captures for selected actors before calling the canonical punch writer',async platform=>{
  const e=await employee();configure([entry(e)]);const write=vi.spyOn(attendanceOwner,'checkInTx');
  try{
   const result=await legacy(e,platform);expect(result.response.status).toBe(platform==='web'?403:200);
   expect(result.body).toEqual(platform==='web'?{error:'integrityRequired'}:{outcome:'refused',code:'integrity_required'});
   expect(result.response.headers.get('cache-control')).toContain('no-store');expect(write).not.toHaveBeenCalled();await noWrites();
  }finally{write.mockRestore();}
 });
 it('does not permit a direct unsigned writer to bypass the policy or a DTO field to claim signed authority',async()=>{
  const e=await employee();configure([entry(e)]);
  await expect(captureEmployeeClock(e.ctx,{...webInput(e),signed:true} as Parameters<typeof captureEmployeeClock>[1])).rejects.toBeInstanceOf(ClockIntegrityRequiredError);
  await expect(captureNativeClock(e.ctx,{...e.command,employmentId:e.employmentId,verified:true} as Parameters<typeof captureNativeClock>[1])).rejects.toBeInstanceOf(ClockIntegrityRequiredError);await noWrites();
 });
 it('preserves exact unsigned receipt recovery after requiring signed clocking and blocks a new reference',async()=>{
  const e=await employee();configure([entry(e,'allow_unverified')]);const accepted=await legacy(e,'mobile');expect(accepted.body.outcome).toBe('accepted');
  configure([entry(e)]);expect((await legacy(e,'mobile')).body).toEqual(accepted.body);
  expect((await legacy(e,'mobile',{...e.command,requestId:randomUUID()})).body).toEqual({outcome:'refused',code:'integrity_required'});
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
 });
 it('retains explicit partial rollout: unlisted actors can use established channels without gaining integrity assurance',async()=>{
  const e=await employee(),peer=await employee();configure([entry(peer)]);caller=e.ctx;
  expect((await legacy(e,'mobile')).body.outcome).toBe('accepted');
  expect(await readMobileClockConfiguration('android',e.ctx,e.employmentId,signal())).toBeNull();
  expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);
 });
 it('rechecks legacy policy after tentative writes and rolls them back when signed clocking becomes required',async()=>{
  const e=await employee();configure([entry(e,'allow_unverified')]);const original=attendanceOwner.checkInTx;
  const write=vi.spyOn(attendanceOwner,'checkInTx').mockImplementationOnce(async(...args)=>{const result=await original(...args);configure([entry(e)]);return result;});
  try{await expect(captureNativeClock(e.ctx,{...e.command,employmentId:e.employmentId})).rejects.toBeInstanceOf(ClockIntegrityRequiredError);expect(write).toHaveBeenCalledOnce();await noWrites();}
  finally{write.mockRestore();}
 });
 it('accepts a signed current-Android command through the real deployment reader/guard while unsigned channels are closed',async()=>{
  const e=await employee();configure([entry(e)]);const f=await signed(e),response=await f.complete();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({outcome:'accepted',receipt:{direction:'in'}});
  expect(f.transport).toHaveBeenCalledOnce();expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
  expect(await(await f.complete()).json()).toMatchObject({outcome:'accepted'});expect(f.transport).toHaveBeenCalledOnce();
 });
 it.each(['removed','actor','policy'] as const)('rolls back signed acceptance when deployment %s changes during Google verification',async change=>{
  const e=await employee(),selected=entry(e);configure([selected]);const f=await signed(e);
  f.transport.mockImplementationOnce(async()=>{
   if(change==='removed')configure([]);
   if(change==='actor')configure([{...selected,actorIds:[randomUUID()]}]);
   if(change==='policy')configure([{...selected,platforms:{...selected.platforms,android:{...selected.platforms.android,configuration:{...androidConfig,policy:{...policy,licensing:'any_evaluated'}}}}}]);
   return Response.json(f.value());
  });
  expect(await(await f.complete()).json()).toEqual({outcome:'unavailable',code:change==='policy'?'configuration_unavailable':'not_configured'});
  expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,f.challengeId)))[0].consumedAt).toBeNull();await noWrites();
 });
 it('authenticates both old channels before their policy checks',async()=>{
  const e=await employee();configure([entry(e)]);unauthenticated=true;
  for(const platform of ['web','mobile'] as const)expect((await legacy(e,platform)).response.status).toBe(401);await noWrites();
 });
});
