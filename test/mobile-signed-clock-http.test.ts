/** Real HTTP/signatures/attendance/RLS. Enrollment verifier and bearer resolution are synthetic. */
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
import {AndroidEnrollmentSettings} from '../lib/mobile-android-enrollment';
import {onlineClockClientData} from '../lib/mobile-clock-integrity';
import {setAttendancePolicy} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
let restore:(()=>Promise<void>)|undefined,base:Base,caller:SessionContext,config:unknown|null,unauthenticated=false,disableOnCommit=false,abortOnCommit:(()=>void)|undefined;
const configuration=vi.fn(async()=>config),guard=vi.fn(async(_tx:Tx,_ctx:SessionContext,_id:string,initial:unknown)=>{
 if(disableOnCommit)config=null;abortOnCommit?.();
 const current=AndroidEnrollmentSettings.safeParse(config);
 if(!current.success||JSON.stringify(current.data)!==JSON.stringify(initial))throw new IntegrityConfigurationUnavailable('configuration_unavailable');
});
const resolve=async()=>{if(unauthenticated)throw new AuthRequiredError();return caller;};
const api=createSignedClockHttpHandlers('android',configuration,resolve,{beforeClockCommit:guard});
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-signed-clock-http-secret-2026');await resetDb();base=await seedBase();config=settings;unauthenticated=false;disableOnCommit=false;abortOnCommit=undefined;configuration.mockClear();guard.mockClear();});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Signed HTTP employee',primaryEmail:randomUUID()+'@clock.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};return {...e,ctx};
}
async function enrolled(){
 const e=await employee(),{publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const enrollment=createAndroidEnrollmentService(settings,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:settings.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(e.ctx,intent);
 const key=await enrollment.complete(e.ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:publicKey.export({type:'spki',format:'der'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]});
 caller=e.ctx;await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 return {...e,privateKey,input:{appInstallationId:intent.appInstallationId,keyId:key.keyId,command:{requestId:randomUUID(),action:'in' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},evidence:{platform:'android' as const,appId:settings.target.packageName,appVersion:'1.0',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}}};
}
function request(id:string,body:unknown,options:{signal?:AbortSignal;extraQuery?:string;photo?:Blob;fields?:[string,string][];padding?:number}={}){
 const form=new FormData();form.append('command',' '.repeat(options.padding??0)+JSON.stringify(body));if(options.photo)form.append('photo',options.photo,'private-file.jpg');for(const [key,value]of options.fields??[])form.append(key,value);
 return new Request('https://untrusted-host.example/api/mobile/v2/integrity/clock?employmentId='+id+(options.extraQuery??''),{method:'POST',body:form,signal:options.signal});
}
async function call(kind:keyof typeof api,id:string,body:unknown,options:Parameters<typeof request>[2]={}){const response=await api[kind](request(id,body,options));return {status:response.status,headers:response.headers,body:await response.json()};}
async function prepared(f:Awaited<ReturnType<typeof enrolled>>){const begin=await call('clockBegin',f.employmentId,f.input);expect(begin.body.outcome).toBe('prepared');return {begin,proof:{...f.input,challengeId:begin.body.context.challenge.id,signature:sign('sha256',Buffer.from(onlineClockClientData(begin.body.context)),f.privateKey).toString('base64')}};}
async function untouched(id:string){expect((await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,id)))[0].consumedAt).toBeNull();expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);}
describe('bounded Android signed clock HTTP boundary without route activation',()=>{
 it('returns typed platform2 preparation and one minimal accepted receipt for concurrent retries',async()=>{
  const f=await enrolled(),{begin,proof}=await prepared(f);expect(begin.body).toMatchObject({protocol:2,state:'active',context:{scope:{apiOrigin:settings.apiOrigin,actorId:f.ctx.userId}}});expect(begin.headers.get('cache-control')).toBe('no-store');
  const [a,b]=await Promise.all([call('clockComplete',f.employmentId,proof),call('clockComplete',f.employmentId,proof)]);expect(a.status).toBe(200);expect(a.body).toEqual(b.body);expect(a.body).toMatchObject({outcome:'accepted',receipt:{direction:'in'}});expect(Object.keys(a.body.receipt).sort()).toEqual(['date','direction','id','photoAvailable','recordedAt']);expect(guard).toHaveBeenCalledOnce();
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);expect(JSON.stringify(a.body)).not.toContain('signature');expect(a.body.receipt).not.toHaveProperty('verifiedLocation');
 });
 it('authenticates and authorizes an explicit own selector before configuration or command parsing',async()=>{
  const f=await enrolled(),peer=await employee();unauthenticated=true;expect((await call('clockBegin',f.employmentId,{bad:true})).status).toBe(401);unauthenticated=false;
  caller=peer.ctx;expect((await call('clockBegin',f.employmentId,{bad:true})).body).toEqual({outcome:'refused',code:'subject_unavailable'});expect(configuration).not.toHaveBeenCalled();
  caller=f.ctx;for(const extraQuery of ['&employmentId='+f.employmentId,'&tenantId='+base.tenantId])expect((await call('clockBegin',f.employmentId,f.input,{extraQuery})).status).toBe(400);
 });
 it('refuses absent guards, unavailable settings and the wrong configured platform without issuing a challenge',async()=>{
  const f=await enrolled(),withoutGuard=createSignedClockHttpHandlers('android',configuration,resolve),response=await withoutGuard.clockBegin(request(f.employmentId,f.input));expect(await response.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect(configuration).not.toHaveBeenCalled();
  for(const value of [null,{...settings,target:{platform:'huawei'}},{apiOrigin:settings.apiOrigin,target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}}]){config=value;expect((await call('clockBegin',f.employmentId,f.input)).body).toMatchObject({outcome:'unavailable'});}
  expect(await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.purpose,'clock.online'))).toHaveLength(0);
  config=settings;const {proof}=await prepared(f),completion=await withoutGuard.clockComplete(request(f.employmentId,proof));expect(await completion.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable'});await untouched(proof.challengeId);
 });
 it('rejects extra authority, Apple proof fields, oversized/duplicate forms and unsupported photos',async()=>{
  const f=await enrolled(),{proof}=await prepared(f);
  for(const body of [{...proof,tenantId:base.tenantId},{...proof,verified:true},{...proof,settings},{...proof,assertion:proof.signature},{...proof,signature:'A'.repeat(100)},{...proof,evidence:{...proof.evidence,platform:'ios'}}])expect((await call('clockComplete',f.employmentId,body)).status).toBe(400);
  for(const options of [{fields:[['command',JSON.stringify(proof)]] as [string,string][]},{fields:[['verified','true']] as [string,string][]},{padding:3*1024*1024},{photo:new Blob(['wrong'],{type:'text/plain'})}])expect((await call('clockComplete',f.employmentId,proof,options)).status).toBe(400);
  expect(guard).not.toHaveBeenCalled();await untouched(proof.challengeId);
 });
 it('maps malformed/invalid signatures and changed bound command bytes to private typed outcomes',async()=>{
  const f=await enrolled(),{proof}=await prepared(f);
  expect((await call('clockComplete',f.employmentId,{...proof,signature:Buffer.alloc(8).toString('base64')})).body).toEqual({outcome:'refused',code:'invalid_proof'});
  expect((await call('clockComplete',f.employmentId,{...proof,signature:sign('sha256',Buffer.from('wrong command'),generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey).toString('base64')})).body).toEqual({outcome:'refused',code:'invalid_proof'});
  expect((await call('clockComplete',f.employmentId,{...proof,command:{...proof.command,lat:4}})).body).toEqual({outcome:'refused',code:'binding_conflict'});await untouched(proof.challengeId);
 });
 it('rolls back tentative attendance and proof if the policy disappears inside the commit guard',async()=>{
  const f=await enrolled(),{proof}=await prepared(f);disableOnCommit=true;
  const result=await call('clockComplete',f.employmentId,proof);expect(result.body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect(guard).toHaveBeenCalledOnce();await untouched(proof.challengeId);
  disableOnCommit=false;config=settings;expect((await call('clockComplete',f.employmentId,proof)).body.outcome).toBe('accepted');
 });
 it('checks request cancellation again after the transactional guard and rolls back every tentative write',async()=>{
  const f=await enrolled(),{proof}=await prepared(f),controller=new AbortController();abortOnCommit=()=>controller.abort();
  expect((await call('clockComplete',f.employmentId,proof,{signal:controller.signal})).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});await untouched(proof.challengeId);
  abortOnCommit=undefined;expect((await call('clockComplete',f.employmentId,proof)).body.outcome).toBe('accepted');
 });
});
