/** Offline clock sync HTTP boundary, handler level: real bearer-session wrapper (resolver injected), env deployment,
 * catalog readiness, draft 0647 SQL/RLS, the keyless issued-context record (owner decision D16: no server signature),
 * App Attest/ECDSA claim proofs, the production snapshot port, the deterministic adjudicator and the canonical writer.
 * Synthetic: enrollment proof, the Google access token and the Play decode transport. No vendor is contacted. */
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as S from '../db/schema';
import {createOfflineSyncHttpHandlers} from '../lib/mobile-api/offline-sync-routes';
import type {MobileBudget} from '../lib/mobile-api/handler';
import {bindOfflineClockContext} from '../lib/mobile-offline-context';
import {offlineClockClaimClientData,type OfflineClockClaimData} from '../lib/mobile-offline-clock';
import {RequestBudgetExceeded} from '../lib/request-budget';
import {AuthRequiredError} from '../lib/auth-errors';
import {setAttendancePolicy} from '../packs/attendance/service';
import {adminCtx,closeAll,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
type Platform='ios'|'android';
const apiOrigin='https://hr.example.com',appId='ABCDEFGHIJ.ai.hr';
// The service fixture's own enrollment settings, so the clock rollout entry owns the same origin and targets.
const ios={apiOrigin,target:{platform:'ios',appId,environment:'production',requiredMetadata:null}};
const android={apiOrigin,target:{platform:'android',packageName:'ai.hr',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const androidPolicy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:60000,allowedFutureSkewMs:1000,locationSignals:{mock:'deny_reported',simulated:'deny_reported',accessory:'allow'}};
const ENV=['AIHR_MOBILE_OFFLINE_POLICY','AIHR_MOBILE_OFFLINE_SIGNING_KEY','AIHR_MOBILE_CLOCK_POLICY','AIHR_MOBILE_ENROLLMENT_POLICY','AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT'];
const notConfigured={outcome:'unavailable',code:'not_configured'};
let base:Base,caller:SessionContext,unauthenticated=false,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
const resolve=async()=>{if(unauthenticated)throw new AuthRequiredError();return caller;};
// Play decode: a token maps to a verdict builder; an unknown token is Google's 400.
const verdicts=new Map<string,()=>unknown>(),accessToken=vi.fn(async()=>'synthetic-google-access');
const transport=vi.fn<typeof fetch>(async(_url,init)=>{const make=verdicts.get(JSON.parse(String(init?.body)).integrityToken);return make?Response.json(make()):new Response(null,{status:400});});
const api={ios:createOfflineSyncHttpHandlers('ios',resolve),android:createOfflineSyncHttpHandlers('android',resolve,{androidPlay:{accessToken,transport}})};
type Handlers=ReturnType<typeof createOfflineSyncHttpHandlers>;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-http-fixture-secret-2026');for(const name of ENV)vi.stubEnv(name,'');verdicts.clear();accessToken.mockClear();transport.mockClear();unauthenticated=false;await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
function configure(actorId:string,overrides:Record<string,unknown>={}){
 vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY',JSON.stringify({version:1,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[actorId],legacySelfService:'allow_unverified',
  platforms:{ios:{configuration:ios},android:{configuration:{settings:android,policy:androidPolicy},cloudProjectNumber:'123456789'}}}]}));
 vi.stubEnv('AIHR_MOBILE_OFFLINE_POLICY',JSON.stringify({version:1,mode:'active',windowMs:86400000,permitCount:2,maximumIssuesPerHour:4,
  photoRetentionMs:2592000000,entries:[{tenantId:base.tenantId,companyId:base.companyId,actorIds:[actorId]}],...overrides}));
}
/** The company's policy row through its own writer, then 0647's offline switch. */
async function offlineOn(enabled=true){
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 await owner.db.execute(sql`update attendance_policy set offline_clocking_enabled=${enabled} where company_id=${base.companyId}::uuid`);
}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Body={json?:unknown;raw?:string;form?:FormData;contentType?:string;query?:string};
async function call(platform:Platform,op:'capabilities'|'context'|'close'|'claim',employmentId:string,body:Body={},handlers:Handlers=api[platform]){
 const path=op==='close'?'offline/context/close':'offline/'+op,url='https://untrusted-host.example/api/mobile/v2/integrity/'+platform+'/'+path+'?employmentId='+employmentId+(body.query??'');
 const init:RequestInit=op==='capabilities'?{method:'GET'}:body.form?{method:'POST',body:body.form}:{method:'POST',headers:{'content-type':body.contentType??'application/json'},body:body.raw??JSON.stringify(body.json)};
 const response=await handlers[op](new Request(url,init)),text=await response.text();
 return {status:response.status,headers:response.headers,body:text?JSON.parse(text):null};
}
type Result=Awaited<ReturnType<typeof call>>;
function upload(signed:unknown,extra:{photo?:Buffer;mime?:string;token?:string;build?:string;raw?:string;fields?:[string,string][]}={}):Body{
 const form=new FormData();form.append('claim',extra.raw??JSON.stringify(signed));
 if(extra.photo)form.append('photo',new Blob([new Uint8Array(extra.photo)],{type:extra.mime??'image/jpeg'}),'capture.jpg');
 if(extra.token!==undefined)form.append('playIntegrityToken',extra.token);if(extra.build!==undefined)form.append('syncBuildVersion',extra.build);
 for(const [key,value] of extra.fields??[])form.append(key,value);return {form};
}
async function counts(){
 const [row]=await owner.db.execute<{contexts:number;permits:number;claims:number;photos:number;punches:number;issued:number}>(sql`select (select count(*) from mobile_offline_context)::int contexts,
  (select count(*) from mobile_offline_permit)::int permits,(select count(*) from mobile_offline_claim)::int claims,(select count(*) from mobile_offline_photo)::int photos,
  (select count(*) from attendance_punch)::int punches,(select count(*) from domain_event where event_type='mobile.offline.context.issued')::int issued`);return {...row};
}
const stream=async(id:string)=>(await owner.db.select().from(S.mobileOfflineContext).where(eq(S.mobileOfflineContext.id,id)))[0];
/** Wait on the database clock until the claim's first whole proven second has passed (acceptance needs one). */
async function settled(context:{issuedAt:number}){
 const whole=Math.ceil(context.issuedAt/1000)*1000;
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(whole).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
}
type Hook=(ctx:SessionContext,input:{employmentId:string;request:unknown})=>Promise<void>;
/** Enroll through the service fixture, then issue through the mounted context route under the real deployment.
 * `before` runs with the deployment configured and before the issuing request; the baseline is restored after it. */
async function enrolled(platform:Platform,options:{before?:Hook;overrides?:Record<string,unknown>}={}){
 const state:{issued?:Result}={};
 const f=await offlineServiceFixture(base,platform,{issue:async(ctx,input)=>{
  caller=ctx;configure(ctx.userId!,options.overrides);await options.before?.(ctx,input);configure(ctx.userId!,options.overrides);
  const issued=await call(platform,'context',input.employmentId,{json:input.request});state.issued=issued;
  if(issued.status!==200||issued.body?.outcome!=='issued')throw new Error('Not issued: '+JSON.stringify(issued.body));
  return {raw:issued.body.context};
 }});
 return {...f,platform,issued:state.issued!,configure:(overrides:Record<string,unknown>={})=>configure(f.ctx.userId!,{...options.overrides,...overrides})};
}
type Fixture=Awaited<ReturnType<typeof enrolled>>;
function claimAt(f:Fixture,sequence:number,previousSha256:string|null,command:Partial<OfflineClockClaimData['command']>={}):OfflineClockClaimData{
 return {...f.claim,permit:f.context.permits[sequence-1],chain:{sequence,previousSha256},command:{...f.claim.command,requestId:randomUUID(),...command}};
}
const digestOf=(claim:OfflineClockClaimData)=>sha(offlineClockClaimClientData(claim));
const post=(f:Fixture,op:'context'|'close'|'claim',body:Body)=>call(f.platform,op,f.e.employmentId,body);
/** A Play standard verdict for one signed Android claim; requestHash recomputed here from the documented formula. */
function verdict(signed:ReturnType<Fixture['signed']>,p:{build?:string;versionCode?:string;requestedAt?:number;hash?:string;device?:string[]}={}){
 const build=p.build??'4',signature=(signed.proof as unknown as {signature:string}).signature;
 const hash=p.hash??createHash('sha256').update(JSON.stringify(['aihr.mobile.integrity',1,'attendance.clock.offline.sync',digestOf(signed.claim),sha(Buffer.from(signature,'base64')),build]),'utf8').digest('base64url');
 return ()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:'ai.hr',requestHash:hash,timestampMillis:String(p.requestedAt??Date.now())},
  appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:'ai.hr',certificateSha256Digest:android.target.certificateDigests,versionCode:p.versionCode??build},
  accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:p.device??['MEETS_DEVICE_INTEGRITY']}}});
}

describe('offline sync routes stay inert until the deployment and the company enable them',()=>{
 it.each(['ios','android'] as const)('%s: without configuration every route answers not_configured and writes nothing',async platform=>{
  await offlineOn();
  const f=await enrolled(platform,{before:async(ctx,input)=>{
   for(const name of ENV)vi.stubEnv(name,'');
   for(const op of ['capabilities','context'] as const){const r=await call(platform,op,input.employmentId,{json:input.request});expect(r.status,op).toBe(200);expect(r.body,op).toEqual(notConfigured);}
   expect(await counts()).toMatchObject({contexts:0,permits:0,issued:0});
  }});
  // Configured, it issued. Withdrawn altogether, close and claim upload are inert too and nothing is consumed.
  for(const name of ENV)vi.stubEnv(name,'');await settled(f.context);
  expect((await call(platform,'capabilities',f.e.employmentId)).body).toEqual(notConfigured);
  expect((await post(f,'close',{json:{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0}})).body).toEqual(notConfigured);
  const r=await post(f,'claim',upload(f.signed(),platform==='android'?{token:'synthetic-play-inert',build:'4'}:{}));expect(r.status).toBe(200);expect(r.body).toEqual(notConfigured);
  expect(await counts()).toMatchObject({contexts:1,claims:0,punches:0});expect((await stream(f.context.id)).nextSequence).toBe(1);expect(transport).not.toHaveBeenCalled();
 });
 it('company offline off: offline_disabled at capabilities and issuance, a refused receipt at claim upload',async()=>{
  await offlineOn(false);
  const f=await enrolled('ios',{before:async(_ctx,input)=>{
   expect((await call('ios','capabilities',input.employmentId)).body).toEqual({outcome:'refused',code:'offline_disabled'});
   expect((await call('ios','context',input.employmentId,{json:input.request})).body).toEqual({outcome:'refused',code:'offline_disabled'});
   expect(await counts()).toMatchObject({contexts:0,permits:0,issued:0});await offlineOn();
  }});
  // Switched off after issuance: the adjudicator refuses the claim, and the refusal commits and advances the stream.
  await offlineOn(false);await settled(f.context);
  const r=await post(f,'claim',upload(f.signed()));
  expect(r.body).toMatchObject({outcome:'processed',receipt:{outcome:'refused',reason:'offline_disabled',sequence:1,captureId:null,effectiveAt:null}});
  expect(await counts()).toMatchObject({claims:1,punches:0});expect((await stream(f.context.id)).nextSequence).toBe(2);
 });
 it('a company that requires a registered device is refused at issuance only (owner decision 5)',async()=>{
  await offlineOn();
  const f=await enrolled('ios',{before:async(_ctx,input)=>{
   await owner.db.execute(sql`update attendance_policy set require_registered_device=true where company_id=${base.companyId}::uuid`);
   expect((await call('ios','context',input.employmentId,{json:input.request})).body).toEqual({outcome:'refused',code:'device_required'});
   expect(await counts()).toMatchObject({contexts:0,permits:0,issued:0});
   await owner.db.execute(sql`update attendance_policy set require_registered_device=false where company_id=${base.companyId}::uuid`);
  }});
  expect(f.issued.body).toMatchObject({outcome:'issued'});expect(await counts()).toMatchObject({contexts:1,issued:1});
 });
 it('drain: no new issuance; exact recovery, claim upload and close stay available',async()=>{
  await offlineOn();const f=await enrolled('ios');f.configure({mode:'drain'});
  expect((await call('ios','capabilities',f.e.employmentId)).body).toEqual({outcome:'offline',enabled:false,apiOrigin,companyId:base.companyId,windowMs:86400000,permitCount:2});
  expect((await post(f,'context',{json:f.request.request})).body).toEqual(f.issued.body);
  await settled(f.context);expect((await post(f,'claim',upload(f.signed()))).body).toMatchObject({outcome:'processed',receipt:{sequence:1}});
  expect((await post(f,'close',{json:{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:1}})).body).toMatchObject({outcome:'closed',reason:'retired',consumedThrough:1});
  // The lease is released, so a new request reaches issuance, which drain refuses.
  const next={...f.request.request,requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')};
  expect((await post(f,'context',{json:next})).body).toEqual({outcome:'unavailable',code:'draining'});expect(await counts()).toMatchObject({contexts:1,issued:1});
 });
});

describe('context issuance, refresh and close',()=>{
 it('issues a recorded (unsigned) context with the deployment window and permit count, and re-posting returns the exact bytes',async()=>{
  await offlineOn();const f=await enrolled('ios');
  const capabilities=await call('ios','capabilities',f.e.employmentId);expect(capabilities.headers.get('cache-control')).toBe('no-store');
  expect(capabilities.body).toEqual({outcome:'offline',enabled:true,apiOrigin,companyId:base.companyId,windowMs:86400000,permitCount:2});
  expect(f.issued.body).toEqual({outcome:'issued',context:f.raw,contextId:f.context.id,authorization:'not_granted'});
  expect(bindOfflineClockContext(f.raw,{scope:f.context.scope,request:f.request.request,target:f.context.target})).toMatchObject({outcome:'bound'});
  expect((await stream(f.context.id)).contextJson).toBe(f.raw);
  expect(f.context.policy.windowMs).toBe(86400000);expect(f.context.permits).toHaveLength(2);expect(f.context.target).toEqual({platform:'ios',appId,environment:'production'});
  const again=await post(f,'context',{json:f.request.request});expect(again.body).toEqual(f.issued.body);expect(await counts()).toMatchObject({contexts:1,permits:2,issued:1});
  // The same request id with another nonce is a conflict, not a refresh; a second request meets the held lease.
  expect((await post(f,'context',{json:{...f.request.request,requestNonce:randomBytes(32).toString('base64url')}})).body).toEqual({outcome:'refused',code:'binding_conflict'});
  expect((await post(f,'context',{json:{...f.request.request,requestId:randomUUID()}})).body).toEqual({outcome:'refused',code:'offline_pending'});
  expect(await counts()).toMatchObject({contexts:1,issued:1});
 });
 it('closes only at the server cursor, replays the closure, and releases the lease',async()=>{
  await offlineOn();const f=await enrolled('ios'),closeRequestId=randomUUID();
  expect((await post(f,'close',{json:{contextId:f.context.id,closeRequestId,consumedThrough:1}})).body).toEqual({outcome:'refused',code:'claims_pending'});
  const closed=await post(f,'close',{json:{contextId:f.context.id,closeRequestId,consumedThrough:0}});
  expect(closed.body).toMatchObject({outcome:'closed',contextId:f.context.id,reason:'retired',closeRequestId,consumedThrough:0});
  expect((await post(f,'close',{json:{contextId:f.context.id,closeRequestId,consumedThrough:0}})).body).toEqual(closed.body);
  expect((await post(f,'close',{json:{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0}})).body).toEqual({outcome:'refused',code:'context_closed'});
  expect((await post(f,'close',{json:{contextId:randomUUID(),closeRequestId:randomUUID(),consumedThrough:0}})).body).toEqual({outcome:'refused',code:'context_unavailable'});
  await settled(f.context);expect((await post(f,'claim',upload(f.signed()))).body).toEqual({outcome:'refused',code:'context_unavailable'});expect(await counts()).toMatchObject({claims:0});
  const next={...f.request.request,requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')};
  expect((await post(f,'context',{json:next})).body).toMatchObject({outcome:'issued'});expect(await counts()).toMatchObject({contexts:2,issued:2});
 });
});

describe('claim upload',()=>{
 it('processes a claim with its photo, replays the receipt without the photo, and refuses a reused request id',async()=>{
  await offlineOn();const f=await enrolled('ios'),bytes=Buffer.from('synthetic offline jpeg bytes');
  const claim=claimAt(f,1,null,{photo:{sha256:sha(bytes),byteLength:bytes.length,mimeType:'image/jpeg'}}),signed=f.signed(claim);await settled(f.context);
  expect((await post(f,'claim',upload(signed,{photo:Buffer.from('tampered offline jpeg bytes')}))).body).toEqual({outcome:'refused',code:'attachment_mismatch'});
  expect((await post(f,'claim',upload(signed))).body).toEqual({outcome:'refused',code:'attachment_mismatch'});expect(await counts()).toMatchObject({claims:0,photos:0});
  const r=await post(f,'claim',upload(signed,{photo:bytes}));
  expect(r.status).toBe(200);expect(r.body).toMatchObject({outcome:'processed',receipt:{sequence:1,digest:digestOf(claim),contextId:f.context.id,requestId:claim.command.requestId,photo:{sha256:sha(bytes)}}});
  const [row]=await owner.db.select().from(S.mobileOfflineClaim);expect(row).toMatchObject({outcome:r.body.receipt.outcome,reason:r.body.receipt.reason});
  expect(await counts()).toMatchObject({claims:1,photos:1});
  // Exact retry: the terminal receipt, with no photo needed and nothing consumed again.
  expect((await post(f,'claim',upload(signed))).body).toEqual(r.body);expect(await counts()).toMatchObject({claims:1,photos:1});
  const reused=claimAt(f,1,null,{requestId:claim.command.requestId,lat:3.5});
  expect((await post(f,'claim',upload(f.signed(reused)))).body).toEqual({outcome:'refused',code:'binding_conflict'});expect(await counts()).toMatchObject({claims:1});
 });
 it('consumes in chain order: N+1 before N is chain_conflict with nothing consumed; then both are processed',async()=>{
  await offlineOn();const f=await enrolled('ios'),first=claimAt(f,1,null),second=claimAt(f,2,digestOf(first));await settled(f.context);
  expect((await post(f,'claim',upload(f.signed(second)))).body).toEqual({outcome:'refused',code:'chain_conflict'});
  expect(await counts()).toMatchObject({claims:0,punches:0});expect((await stream(f.context.id)).nextSequence).toBe(1);
  expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].assertionCounter).toBe(0);
  const one=await post(f,'claim',upload(f.signed(first)));
  expect(one.body).toMatchObject({outcome:'processed',receipt:{outcome:'accepted',reason:'clock_accepted',sequence:1}});expect(await counts()).toMatchObject({claims:1,punches:1});
  expect((await post(f,'claim',upload(f.signed(second)))).body).toMatchObject({outcome:'processed',receipt:{sequence:2,digest:digestOf(second)}});
  expect(await stream(f.context.id)).toMatchObject({nextSequence:3,closeReason:'exhausted'});
  // The original App Attest counters, in order; no transport assertion advanced it.
  expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].assertionCounter).toBe(2);
 });
 it('bounds every body before parsing (400, as online) and answers a framed but malformed claim with a typed refusal',async()=>{
  await offlineOn();const f=await enrolled('ios'),signed=f.signed(),json=JSON.stringify(signed);
  const bad=async(body:Body,op:'context'|'claim'='claim')=>{const r=await post(f,op,body);expect(r.status,JSON.stringify(r.body)).toBe(400);expect(r.body).toEqual({error:'bad_request'});};
  await bad({raw:JSON.stringify(f.request.request)+' '.repeat(1024)},'context');await bad({raw:JSON.stringify(f.request.request),contentType:'text/plain'},'context');await bad({json:{requestId:'x'}},'context');
  await bad({raw:' '.repeat(16385)+json,contentType:'multipart/form-data; boundary=x'});
  await bad(upload(signed,{raw:' '.repeat(16385)+json}));
  await bad(upload(signed,{photo:Buffer.alloc(2097153,1)}));await bad(upload(signed,{photo:Buffer.alloc(3145729,1)}));await bad(upload(signed,{photo:Buffer.from('gif'),mime:'image/gif'}));
  await bad(upload(signed,{fields:[['playIntegrityToken','synthetic']]}));await bad(upload(signed,{fields:[['claim',json]]}));await bad(upload(signed,{fields:[['extra','x']]}));
  await bad({json:signed});
  for(const raw of ['{','{}',JSON.stringify({...signed,proof:{platform:'android',signature:'AAAA'}}),JSON.stringify({claim:signed.claim})]){
   const r=await post(f,'claim',upload(signed,{raw}));expect(r.status,raw.slice(0,40)).toBe(200);expect(r.body).toEqual({outcome:'refused',code:'invalid_claim'});
  }
  expect(await counts()).toMatchObject({contexts:1,claims:0,photos:0});expect((await stream(f.context.id)).nextSequence).toBe(1);
 });
});

describe('bearer session, selector and budgets',()=>{
 it('authenticates and proves the own selector before any body or deployment read',async()=>{
  await offlineOn();const f=await enrolled('ios');
  unauthenticated=true;for(const op of ['capabilities','context','close','claim'] as const)expect((await call('ios',op,f.e.employmentId,{json:{}})).status,op).toBe(401);unauthenticated=false;
  expect((await call('ios','context',randomUUID(),{json:f.request.request})).body).toEqual({outcome:'refused',code:'subject_unavailable'});
  expect((await call('ios','capabilities',f.e.employmentId,{query:'&tenantId='+base.tenantId})).status).toBe(400);
  expect(await counts()).toMatchObject({contexts:1,issued:1});
 });
 it('charges a weighted hourly budget on claim upload only, and answers exhaustion with 429',async()=>{
  await offlineOn();const f=await enrolled('ios'),budget=vi.fn<MobileBudget>(async()=>{}),handlers=createOfflineSyncHttpHandlers('ios',resolve,{budget});
  const weighted=()=>budget.mock.calls.filter(([scope])=>scope[0]==='mobile-offline-claim');
  await call('ios','context',f.e.employmentId,{json:f.request.request},handlers);await call('ios','capabilities',f.e.employmentId,{},handlers);expect(weighted()).toEqual([]);
  expect((await call('ios','claim',f.e.employmentId,upload(f.signed(),{raw:'{'}),handlers)).body).toEqual({outcome:'refused',code:'invalid_claim'});
  expect(weighted()).toEqual([[['mobile-offline-claim',base.tenantId,f.ctx.userId],64,3600]]);
  budget.mockImplementation(async scope=>{if(scope[0]==='mobile-offline-claim')throw new RequestBudgetExceeded(42);});await settled(f.context);
  const refused=await call('ios','claim',f.e.employmentId,upload(f.signed()),handlers);
  expect(refused.status).toBe(429);expect(refused.headers.get('retry-after')).toBe('42');expect(refused.body).toEqual({error:'unavailable'});expect(await counts()).toMatchObject({claims:0});
 });
 it('maps the issuance admission budget (RequestBudgetExceeded) to 429 and writes nothing',async()=>{
  await offlineOn();const f=await enrolled('ios',{overrides:{maximumIssuesPerHour:1}});
  expect((await post(f,'close',{json:{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0}})).body).toMatchObject({outcome:'closed'});
  const r=await post(f,'context',{json:{...f.request.request,requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url')}});
  expect(r.status).toBe(429);expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);expect(r.body).toEqual({error:'unavailable'});expect(await counts()).toMatchObject({contexts:1,issued:1});
 });
});

describe('Android sync-time Play binding (owner decision 4)',()=>{
 it('refuses every failed or unbound verdict with no receipt, then processes the bound claim and replays it without a token',async()=>{
  await offlineOn();const f=await enrolled('android'),signed=f.signed();await settled(f.context);
  const refusal=async(extra:Parameters<typeof upload>[1],expected:unknown)=>{
   const r=await post(f,'claim',upload(signed,extra));expect(r.status).toBe(200);expect(r.body).toEqual(expected);
   expect(await counts()).toMatchObject({claims:0,punches:0});expect((await stream(f.context.id)).nextSequence).toBe(1);
  };
  const sync=(integrityReason:string)=>({outcome:'refused',code:'sync_integrity',integrityReason});
  // Before any provider request: a missing token, and a build the deployment does not admit.
  await refusal({},sync('token_missing'));await refusal({token:'synthetic-play-build',build:'5'},sync('version_mismatch'));expect(transport).not.toHaveBeenCalled();
  await expect(post(f,'claim',upload(signed,{token:'synthetic-play-alone'}))).resolves.toMatchObject({status:400});
  const cases:[string,ReturnType<typeof verdict>|null,unknown][]=[
   ['synthetic-play-hash',verdict(signed,{hash:sha('another payload').slice(0,43)}),sync('request_mismatch')],
   ['synthetic-play-other-build',verdict(signed,{build:'5'}),sync('request_mismatch')],
   ['synthetic-play-stale',verdict(signed,{requestedAt:Date.now()-120000}),sync('stale_token')],
   ['synthetic-play-future',verdict(signed,{requestedAt:Date.now()+60000}),sync('stale_token')],
   ['synthetic-play-version',verdict(signed,{versionCode:'5'}),sync('version_mismatch')],
   ['synthetic-play-device',verdict(signed,{device:['MEETS_BASIC_INTEGRITY']}),sync('device_integrity')],
   ['synthetic-play-unknown',null,sync('invalid_token')],
  ];
  for(const [token,make,expected] of cases){if(make)verdicts.set(token,make);await refusal({token,build:'4'},expected);}
  transport.mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_ERROR',{status:503}));
  await refusal({token:'synthetic-play-outage',build:'4'},{outcome:'unavailable',code:'proof_unavailable',integrityReason:'provider_unavailable'});
  // The phone kept the claim queued; the bound verdict now processes it.
  verdicts.set('synthetic-play-bound',verdict(signed));transport.mockClear();
  const ok=await post(f,'claim',upload(signed,{token:'synthetic-play-bound',build:'4'}));
  expect(ok.body).toMatchObject({outcome:'processed',receipt:{outcome:'accepted',sequence:1,digest:digestOf(f.claim)}});expect(transport).toHaveBeenCalledOnce();
  const [url,init]=transport.mock.calls[0];expect(String(url)).toBe('https://playintegrity.googleapis.com/v1/ai.hr:decodeIntegrityToken');expect(JSON.parse(String(init?.body))).toEqual({integrityToken:'synthetic-play-bound'});
  transport.mockClear();expect((await post(f,'claim',upload(signed))).body).toEqual(ok.body);expect(transport).not.toHaveBeenCalled();
  expect(await counts()).toMatchObject({claims:1,punches:1});
  expect(JSON.stringify(await owner.db.select({payload:S.domainEvent.payload}).from(S.domainEvent))).not.toMatch(/synthetic-play|synthetic-google-access/);
 });
});
