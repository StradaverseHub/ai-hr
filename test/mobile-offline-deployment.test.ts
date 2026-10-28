/** The mounted offline sync route files reach the deployed operations: real getMobileSession wrapper (session mocked),
 * env deployment, draft 0647, signatures, the production snapshot port, adjudicator and canonical writer, and on Android
 * the deployed service-account provider and Play decode over a stubbed global fetch. Without AIHR_MOBILE_OFFLINE_POLICY
 * every mounted route answers not_configured. Synthetic: enrollment proof, issuer key, RSA credential, vendor HTTP. */
import {createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as S from '../db/schema';
import {offlineContextIssuerIdentity} from '../lib/mobile-api/offline-context-signature';
import {offlineClockClaimClientData} from '../lib/mobile-offline-clock';
import {setAttendancePolicy} from '../packs/attendance/service';
import {GET as iosCapabilities} from '../app/api/mobile/v2/integrity/ios/offline/capabilities/route';
import {POST as iosContext} from '../app/api/mobile/v2/integrity/ios/offline/context/route';
import {POST as iosClose} from '../app/api/mobile/v2/integrity/ios/offline/context/close/route';
import {POST as iosClaim} from '../app/api/mobile/v2/integrity/ios/offline/claim/route';
import {GET as androidCapabilities} from '../app/api/mobile/v2/integrity/android/offline/capabilities/route';
import {POST as androidContext} from '../app/api/mobile/v2/integrity/android/offline/context/route';
import {POST as androidClose} from '../app/api/mobile/v2/integrity/android/offline/context/close/route';
import {POST as androidClaim} from '../app/api/mobile/v2/integrity/android/offline/claim/route';
import {adminCtx,closeAll,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
type Platform='ios'|'android';
const apiOrigin='https://hr.example.com';
const ios={apiOrigin,target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',requiredMetadata:null}};
const android={apiOrigin,target:{platform:'android',packageName:'ai.hr',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const androidPolicy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,locationSignals:{mock:'deny_reported',simulated:'deny_reported',accessory:'allow'}};
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const credential=JSON.stringify({type:'service_account',client_email:'offline@synthetic-project.iam.gserviceaccount.com',private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()});
const ENV=['AIHR_MOBILE_OFFLINE_POLICY','AIHR_MOBILE_OFFLINE_SIGNING_KEY','AIHR_MOBILE_CLOCK_POLICY','AIHR_MOBILE_ENROLLMENT_POLICY','AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT'];
const routes={ios:{capabilities:iosCapabilities,context:iosContext,close:iosClose,claim:iosClaim},android:{capabilities:androidCapabilities,context:androidContext,close:androidClose,claim:androidClaim}};
const notConfigured={outcome:'unavailable',code:'not_configured'};
let base:Base,caller:SessionContext,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>caller}));
// Every vendor request goes through this stub; a test installs its own decode answer.
let decode:(token:string)=>Response=()=>new Response(null,{status:400});
const fetchStub=vi.fn<typeof fetch>(async(url,init)=>String(url)==='https://oauth2.googleapis.com/token'?Response.json({access_token:'synthetic-oauth-access',token_type:'Bearer',expires_in:3600}):decode(JSON.parse(String(init?.body)).integrityToken));
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-mounted-fixture-secret-2026');for(const name of ENV)vi.stubEnv(name,'');fetchStub.mockClear();decode=()=>new Response(null,{status:400});vi.stubGlobal('fetch',fetchStub);await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();vi.unstubAllGlobals();await closeAll();}});
function configure(actorId:string){
 const {privateKey}=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(privateKey),issuer={...identity,validFrom:Date.now()-86400000,validUntil:Date.now()+7*86400000,revoked:false};
 vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',JSON.stringify({version:1,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[actorId],legacySelfService:'allow_unverified',
  platforms:{ios:{configuration:ios},android:{configuration:{settings:android,policy:androidPolicy},cloudProjectNumber:'123456789'}}}]}));
 vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify({version:1,mode:'active',signingKeyId:issuer.keyId,issuers:[issuer],windowMs:86400000,permitCount:2,maximumIssuesPerHour:4,
  photoRetentionMs:2592000000,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[actorId]}]}));
 vi.stubEnv('AIHR_MOBILE_OFFLINE_SIGNING_KEY',privateKey.export({type:'pkcs8',format:'pem'}).toString());
 return issuer;
}
async function offlineOn(){
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 await owner.db.execute(sql`update attendance_policy set offline_clocking_enabled=true where company_id=${base.companyId}::uuid`);
}
async function call(platform:Platform,op:'capabilities'|'context'|'close'|'claim',employmentId:string,body?:unknown,form?:FormData){
 const path=op==='close'?'offline/context/close':'offline/'+op;
 const init:RequestInit=op==='capabilities'?{method:'GET'}:form?{method:'POST',body:form}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};
 const response=await routes[platform][op](new Request('https://untrusted-host.test/api/mobile/v2/integrity/'+platform+'/'+path+'?employmentId='+employmentId,init));
 return {status:response.status,body:await response.json()};
}
function claimForm(signed:unknown,android?:{token:string}){
 const form=new FormData();form.append('claim',JSON.stringify(signed));if(android){form.append('playIntegrityToken',android.token);form.append('syncBuildVersion','4');}return form;
}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
async function counts(){
 const [row]=await owner.db.execute<{contexts:number;claims:number;punches:number}>(sql`select (select count(*) from mobile_offline_context)::int contexts,(select count(*) from mobile_offline_claim)::int claims,(select count(*) from attendance_punch)::int punches`);return {...row};
}
async function settled(context:{issuedAt:number}){
 const whole=Math.ceil(context.issuedAt/1000)*1000;
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(whole).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
}
describe.each(['ios','android'] as const)('%s mounted offline sync routes',platform=>{
 it('answer not_configured on every route while the deployment variable is absent',async()=>{
  // The fixture's own service issues a context and builds a valid claim; the deployment stays absent.
  const f=await offlineServiceFixture(base,platform);caller=f.ctx;
  expect(await call(platform,'capabilities',f.e.employmentId)).toEqual({status:200,body:notConfigured});
  const request={...f.request.request,requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')};
  expect(await call(platform,'context',f.e.employmentId,request)).toEqual({status:200,body:notConfigured});
  expect(await call(platform,'close',f.e.employmentId,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0})).toEqual({status:200,body:notConfigured});
  expect(await call(platform,'claim',f.e.employmentId,undefined,claimForm(f.signed(),platform==='android'?{token:'synthetic-play-absent'}:undefined))).toEqual({status:200,body:notConfigured});
  expect(await counts()).toEqual({contexts:1,claims:0,punches:0});expect(fetchStub).not.toHaveBeenCalled();
 });
 it('reach the deployed operations: issue, capabilities, a processed claim, its replay and close',async()=>{
  await offlineOn();if(platform==='android')vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);
  let issuer:ReturnType<typeof configure>|undefined;
  const f=await offlineServiceFixture(base,platform,{issue:async(ctx,input)=>{
   caller=ctx;issuer=configure(ctx.userId!);if(platform==='android')vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',credential);
   const r=await call(platform,'context',input.employmentId,input.request);if(r.body.outcome!=='issued')throw new Error('Not issued: '+JSON.stringify(r.body));return {raw:r.body.context};
  }});
  expect((await call(platform,'capabilities',f.e.employmentId)).body).toEqual({outcome:'offline',enabled:true,apiOrigin,issuers:[issuer],windowMs:86400000,permitCount:2});
  expect(f.context.target.platform).toBe(platform);expect(f.context.permits).toHaveLength(2);
  const signed=f.signed();await settled(f.context);
  if(platform==='android'){
   const signature=(signed.proof as unknown as {signature:string}).signature;
   const hash=createHash('sha256').update(JSON.stringify(['aihr.mobile.integrity',1,'attendance.clock.offline.sync',sha(offlineClockClaimClientData(f.claim)),sha(Buffer.from(signature,'base64')),'4'])).digest('base64url');
   decode=token=>token==='synthetic-play-mounted'?Response.json({tokenPayloadExternal:{requestDetails:{requestPackageName:'ai.hr',requestHash:hash,timestampMillis:String(Date.now())},
    appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:'ai.hr',certificateSha256Digest:android.target.certificateDigests,versionCode:'4'},accountDetails:{appLicensingVerdict:'LICENSED'},
    deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}}):new Response(null,{status:400});
  }
  const processed=await call(platform,'claim',f.e.employmentId,undefined,claimForm(signed,platform==='android'?{token:'synthetic-play-mounted'}:undefined));
  expect(processed).toMatchObject({status:200,body:{outcome:'processed',receipt:{outcome:'accepted',sequence:1,contextId:f.context.id}}});
  if(platform==='ios')expect(fetchStub).not.toHaveBeenCalled();
  else expect(fetchStub.mock.calls.map(([url])=>String(url))).toEqual(['https://oauth2.googleapis.com/token','https://playintegrity.googleapis.com/v1/ai.hr:decodeIntegrityToken']);
  fetchStub.mockClear();expect((await call(platform,'claim',f.e.employmentId,undefined,claimForm(signed))).body).toEqual(processed.body);expect(fetchStub).not.toHaveBeenCalled();
  expect((await call(platform,'close',f.e.employmentId,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:1})).body).toMatchObject({outcome:'closed',reason:'retired',consumedThrough:1});
  expect(await counts()).toEqual({contexts:1,claims:1,punches:1});
  expect((await owner.db.select().from(S.mobileOfflineContext).where(eq(S.mobileOfflineContext.id,f.context.id)))[0]).toMatchObject({nextSequence:2,closeReason:'retired'});
 });
});
it('mounted Android routes neither advertise nor issue without a valid Google service-account credential',async()=>{
 await offlineOn();const f=await offlineServiceFixture(base,'android');caller=f.ctx;configure(f.ctx.userId!);
 // The fixture's own context holds the lease, so the issuance below must refuse before reaching the issuance service.
 for(const value of ['','{',JSON.stringify({type:'authorized_user'})]){
  vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',value);
  expect((await call('android','capabilities',f.e.employmentId)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
  expect((await call('android','context',f.e.employmentId,{...f.request.request,requestId:randomUUID()})).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
 }
 expect(fetchStub).not.toHaveBeenCalled();expect(await counts()).toMatchObject({contexts:1,claims:0});
});
