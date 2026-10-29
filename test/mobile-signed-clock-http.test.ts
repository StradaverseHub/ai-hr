/** Real HTTP/Google decoder/signatures/attendance/RLS. Vendor transport, enrollment and bearer resolution are synthetic. */
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {createSignedClockHttpHandlers} from '../lib/mobile-api/signed-clock-routes';
import {IntegrityConfigurationUnavailable} from '../lib/mobile-api/integrity-configuration';
import {AuthRequiredError} from '../lib/auth-errors';
import {AndroidClockConfiguration} from '../lib/mobile-android-clock-policy';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';
import {todayInKualaLumpur} from '../lib/hr-date';
import {onlineClockClientData,type OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {setAttendancePolicy} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const policy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,
 locationSignals:{mock:'deny_reported',simulated:'deny_reported',accessory:'allow'}};
const clockConfig={settings,policy},contexts=new Map<string,OnlineClockIntegrityData>();
const tokenFor=(id:string)=>'synthetic-play-'+id;
function payload(context:OnlineClockIntegrityData){return {tokenPayloadExternal:{
 requestDetails:{requestPackageName:settings.target.packageName,requestHash:onlineClockClientDataHash(context).toString('base64url'),timestampMillis:String(Date.now())},
 appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:settings.target.packageName,certificateSha256Digest:settings.target.certificateDigests,versionCode:'4'},
 accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}};}
const accessToken=vi.fn(async()=> 'synthetic-google-access'),transport=vi.fn<typeof fetch>(async(_url,init)=>{
 const token=JSON.parse(String(init?.body)).integrityToken,context=contexts.get(token);
 return context?Response.json(payload(context)):new Response(null,{status:400});
});
let restore:(()=>Promise<void>)|undefined,base:Base,caller:SessionContext,config:unknown|null,unauthenticated=false,disableOnCommit=false,abortOnCommit:(()=>void)|undefined;
const configuration=vi.fn(async()=>config),guard=vi.fn(async(_tx:Tx,_ctx:SessionContext,_id:string,initial:unknown)=>{
 if(disableOnCommit)config=null;abortOnCommit?.();
 const current=AndroidClockConfiguration.safeParse(config);
 if(!current.success||JSON.stringify(current.data)!==JSON.stringify(initial))throw new IntegrityConfigurationUnavailable('configuration_unavailable');
});
const resolve=async()=>{if(unauthenticated)throw new AuthRequiredError();return caller;};
const api=createSignedClockHttpHandlers('android',configuration,resolve,{beforeClockCommit:guard,androidPlay:{accessToken,transport}});
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-signed-clock-http-secret-2026');await resetDb();base=await seedBase();config=clockConfig;contexts.clear();accessToken.mockClear();transport.mockClear();unauthenticated=false;disableOnCommit=false;abortOnCommit=undefined;configuration.mockClear();guard.mockClear();});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Signed HTTP employee',primaryEmail:randomUUID()+'@clock.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};return {...e,ctx};
}
async function enrolled(){
 const e=await employee(),{publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const enrollment=createAndroidEnrollmentService(settings,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:settings.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(e.ctx,intent);
 const key=await enrollment.complete(e.ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:publicKey.export({type:'spki',format:'der'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]});
 caller=e.ctx;await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 return {...e,privateKey,input:{appInstallationId:intent.appInstallationId,keyId:key.keyId,command:{requestId:randomUUID(),action:'in' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},evidence:{platform:'android' as const,appId:settings.target.packageName,appVersion:'1.0',buildVersion:'4',provider:null,mock:null as boolean|null,simulated:null,accessory:null}}};
}
function request(id:string,body:unknown,options:{signal?:AbortSignal;extraQuery?:string;photo?:Blob;fields?:[string,string][];padding?:number;token?:string|Blob|null}={}){
 const form=new FormData();
 const challengeId=(body as {challengeId?:string})?.challengeId,token=options.token===undefined&&challengeId?tokenFor(challengeId):options.token;
 if(token!==undefined&&token!==null)form.append('playIntegrityToken',token);
 form.append('command',' '.repeat(options.padding??0)+JSON.stringify(body));if(options.photo)form.append('photo',options.photo,'private-file.jpg');for(const [key,value]of options.fields??[])form.append(key,value);
 return new Request('https://untrusted-host.example/api/mobile/v2/integrity/clock?employmentId='+id+(options.extraQuery??''),{method:'POST',body:form,signal:options.signal});
}
async function call(kind:keyof typeof api,id:string,body:unknown,options:Parameters<typeof request>[2]={}){const response=await api[kind](request(id,body,options));return {status:response.status,headers:response.headers,body:await response.json()};}
async function prepared(f:Awaited<ReturnType<typeof enrolled>>){const begin=await call('clockBegin',f.employmentId,f.input);expect(begin.body.outcome).toBe('prepared');contexts.set(tokenFor(begin.body.context.challenge.id),begin.body.context);return {begin,proof:{...f.input,challengeId:begin.body.context.challenge.id,signature:sign('sha256',Buffer.from(onlineClockClientData(begin.body.context)),f.privateKey).toString('base64')}};}
async function untouched(id:string){expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,id)))[0].consumedAt).toBeNull();expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);}
describe('bounded Android signed clock HTTP boundary without route activation',()=>{
 it('returns typed platform2 preparation and one minimal accepted receipt for concurrent retries',async()=>{
  const f=await enrolled(),{begin,proof}=await prepared(f);expect(begin.body).toMatchObject({protocol:2,state:'active',context:{scope:{apiOrigin:settings.apiOrigin,actorId:f.ctx.userId}}});expect(begin.headers.get('cache-control')).toBe('no-store');
  const [a,b]=await Promise.all([call('clockComplete',f.employmentId,proof),call('clockComplete',f.employmentId,proof)]);expect(a.status).toBe(200);expect(a.body).toEqual(b.body);expect(a.body).toMatchObject({outcome:'accepted',receipt:{direction:'in'}});expect(Object.keys(a.body.receipt).sort()).toEqual(['date','direction','id','photoAvailable','recordedAt']);expect(guard).toHaveBeenCalledOnce();
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);expect(JSON.stringify(a.body)).not.toContain('signature');expect(a.body.receipt).not.toHaveProperty('verifiedLocation');expect(JSON.stringify(a.body)).not.toContain('synthetic-play');
  const [audit]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'));
  expect(audit.payload).toMatchObject({verification:'command_signature',currentIntegrity:{verification:'google_play_standard',locationVerification:'not_verified'}});
 });
 it('authenticates and authorizes an explicit own selector before configuration or command parsing',async()=>{
  const f=await enrolled(),peer=await employee();unauthenticated=true;expect((await call('clockBegin',f.employmentId,{bad:true})).status).toBe(401);unauthenticated=false;
  caller=peer.ctx;expect((await call('clockBegin',f.employmentId,{bad:true})).body).toEqual({outcome:'refused',code:'subject_unavailable'});expect(configuration).not.toHaveBeenCalled();
  caller=f.ctx;for(const extraQuery of ['&employmentId='+f.employmentId,'&tenantId='+base.tenantId])expect((await call('clockBegin',f.employmentId,f.input,{extraQuery})).status).toBe(400);
 });
 it('refuses absent guards, unavailable settings and the wrong configured platform without issuing a challenge',async()=>{
  const f=await enrolled(),withoutGuard=createSignedClockHttpHandlers('android',configuration,resolve),response=await withoutGuard.clockBegin(request(f.employmentId,f.input));expect(await response.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect(configuration).not.toHaveBeenCalled();
  for(const value of [null,settings,{settings},{...clockConfig,policy:{}},{...settings,target:{platform:'huawei'}},{apiOrigin:settings.apiOrigin,target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}}]){config=value;expect((await call('clockBegin',f.employmentId,f.input)).body).toMatchObject({outcome:'unavailable'});}
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.purpose,'clock.online'))).toHaveLength(0);
  config=clockConfig;const {proof}=await prepared(f),completion=await withoutGuard.clockComplete(request(f.employmentId,proof));expect(await completion.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable'});await untouched(proof.challengeId);
 });
 it('rejects extra authority, Apple proof fields, oversized/duplicate forms and unsupported photos',async()=>{
  const f=await enrolled(),{proof}=await prepared(f);
  for(const body of [{...proof,tenantId:base.tenantId},{...proof,verified:true},{...proof,settings},{...proof,assertion:proof.signature},{...proof,signature:'A'.repeat(100)},{...proof,evidence:{...proof.evidence,platform:'ios'}}])expect((await call('clockComplete',f.employmentId,body)).status).toBe(400);
  for(const options of [{fields:[['command',JSON.stringify(proof)]] as [string,string][]},{fields:[['verified','true']] as [string,string][]},{padding:3*1024*1024},{photo:new Blob(['wrong'],{type:'text/plain'})}])expect((await call('clockComplete',f.employmentId,proof,options)).status).toBe(400);
  expect(guard).not.toHaveBeenCalled();await untouched(proof.challengeId);
 });
 it('bounds the command field before JSON parsing while accepting its complete allowed envelope',async()=>{
  const f=await enrolled(),{proof}=await prepared(f),padding=16384-Buffer.byteLength(JSON.stringify(proof),'utf8');expect(padding).toBeGreaterThan(0);
  expect((await call('clockComplete',f.employmentId,proof,{padding:padding+1})).status).toBe(400);expect(guard).not.toHaveBeenCalled();await untouched(proof.challengeId);
  expect((await call('clockComplete',f.employmentId,proof,{padding})).body.outcome).toBe('accepted');
 });
 it('maps malformed/invalid signatures and changed bound command bytes to private typed outcomes',async()=>{
  const f=await enrolled(),{proof}=await prepared(f);
  expect((await call('clockComplete',f.employmentId,{...proof,signature:Buffer.alloc(8).toString('base64')})).body).toEqual({outcome:'refused',code:'invalid_proof'});
  expect((await call('clockComplete',f.employmentId,{...proof,signature:sign('sha256',Buffer.from('wrong command'),generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey).toString('base64')})).body).toEqual({outcome:'refused',code:'invalid_proof'});
  expect((await call('clockComplete',f.employmentId,{...proof,command:{...proof.command,lat:4}})).body).toEqual({outcome:'refused',code:'binding_conflict'});expect(transport).not.toHaveBeenCalled();await untouched(proof.challengeId);
 });
 it('rolls back tentative attendance and proof if the policy disappears inside the commit guard',async()=>{
  const f=await enrolled(),{proof}=await prepared(f);disableOnCommit=true;
  const result=await call('clockComplete',f.employmentId,proof);expect(result.body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect(guard).toHaveBeenCalledOnce();await untouched(proof.challengeId);
  disableOnCommit=false;config=clockConfig;expect((await call('clockComplete',f.employmentId,proof)).body.outcome).toBe('accepted');
 });
 it('checks request cancellation again after the transactional guard and rolls back every tentative write',async()=>{
  const f=await enrolled(),{proof}=await prepared(f),controller=new AbortController();abortOnCommit=()=>controller.abort();
  expect((await call('clockComplete',f.employmentId,proof,{signal:controller.signal})).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});await untouched(proof.challengeId);
  abortOnCommit=undefined;expect((await call('clockComplete',f.employmentId,proof)).body.outcome).toBe('accepted');
 });
 it('requires an opaque separately bounded token and preserves the independent command bound',async()=>{
  const f=await enrolled(),{proof,begin}=await prepared(f);
  for(const token of [null,'','with space','x\ny','é', 'A'.repeat(32769),new Blob(['decoded'],{type:'application/json'})]){
   expect((await call('clockComplete',f.employmentId,proof,{token})).status).toBe(400);
  }
  expect((await call('clockComplete',f.employmentId,proof,{fields:[['playIntegrityToken',tokenFor(proof.challengeId)]]})).status).toBe(400);
  expect((await call('clockComplete',f.employmentId,{...proof,playIntegrityToken:tokenFor(proof.challengeId)})).status).toBe(400);
  expect((await call('clockBegin',f.employmentId,f.input,{token:'extra'})).status).toBe(400);
  expect(transport).not.toHaveBeenCalled();expect(guard).not.toHaveBeenCalled();await untouched(proof.challengeId);
  const token='T'.repeat(32768);contexts.set(token,begin.body.context);
  const padding=16384-Buffer.byteLength(JSON.stringify(proof),'utf8');
  expect((await call('clockComplete',f.employmentId,proof,{token,padding:padding+1})).status).toBe(400);expect(transport).not.toHaveBeenCalled();
  expect((await call('clockComplete',f.employmentId,proof,{token,padding})).body.outcome).toBe('accepted');expect(transport).toHaveBeenCalledOnce();
 });
 it.each(['outage','hash','device','mock','license','unknown'] as const)('refuses current %s evidence through HTTP without a punch or leaked vendor data',async failure=>{
  const f=await enrolled();if(failure==='mock')f.input.evidence.mock=true;
  const {proof,begin}=await prepared(f),value=payload(begin.body.context);
  if(failure==='outage')transport.mockResolvedValueOnce(new Response('PRIVATE_VENDOR_DIAGNOSTIC',{status:503}));
  if(failure==='hash')value.tokenPayloadExternal.requestDetails.requestHash='B'.repeat(43);
  if(failure==='device')value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict=['MEETS_BASIC_INTEGRITY'];
  if(failure==='license')value.tokenPayloadExternal.accountDetails.appLicensingVerdict='UNLICENSED';
  if(failure==='unknown')value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict=['MEETS_DEVICE_INTEGRITY','FUTURE_UNKNOWN_LABEL'];
  if(failure!=='outage')transport.mockResolvedValueOnce(Response.json(value));
  const response=await call('clockComplete',f.employmentId,proof);
  const reason={outage:'provider_unavailable',hash:'invalid_proof',device:'device_integrity',mock:'reported_mock',license:'unlicensed_app',unknown:'unknown_vendor_verdict'}[failure];
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.body).toEqual({outcome:['outage','unknown'].includes(failure)?'unavailable':'refused',code:['outage','unknown'].includes(failure)?'proof_unavailable':'invalid_proof',integrityReason:reason});
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_VENDOR|synthetic-play|FUTURE_UNKNOWN_LABEL/);
  expect(transport).toHaveBeenCalledOnce();expect(guard).not.toHaveBeenCalled();await untouched(proof.challengeId);
 });
 it('requires server-owned Google readiness for a fresh challenge but permits exact committed receipt recovery during an outage',async()=>{
  const f=await enrolled(),noGoogle=createSignedClockHttpHandlers('android',configuration,resolve,{beforeClockCommit:guard});
  const response=await noGoogle.clockBegin(request(f.employmentId,f.input));
  expect(await response.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable',integrityReason:'configuration_unavailable'});
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.purpose,'clock.online'))).toHaveLength(0);
  const {proof}=await prepared(f),pending=await noGoogle.clockComplete(request(f.employmentId,proof));
  expect(await pending.json()).toMatchObject({outcome:'unavailable',code:'configuration_unavailable'});await untouched(proof.challengeId);
  const accepted=await call('clockComplete',f.employmentId,proof);expect(accepted.body.outcome).toBe('accepted');
  transport.mockClear();const replay=await noGoogle.clockComplete(request(f.employmentId,proof));expect(await replay.json()).toEqual(accepted.body);expect(transport).not.toHaveBeenCalled();
 });
 it('revalidates the whole clock configuration including policy after Google and rolls back on a policy change',async()=>{
  const f=await enrolled(),{proof,begin}=await prepared(f);
  transport.mockImplementationOnce(async()=>{config={settings,policy:{...policy,licensing:'any_evaluated'}};return Response.json(payload(begin.body.context));});
  expect((await call('clockComplete',f.employmentId,proof)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  expect(guard).toHaveBeenCalledOnce();await untouched(proof.challengeId);
 });

});
