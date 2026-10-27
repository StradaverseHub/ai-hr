/** Real HTTP wrappers, services, signatures and RLS. Only bearer resolution and enrollment seed proof are synthetic. */
import {createHash,generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import cbor from 'cbor';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService} from '../core/mobile-apple-enrollment';
import {createClockingLocation,setClockingControl,setAttendancePolicy} from '../packs/attendance/service';
import {GET as ownKeys} from '../app/api/mobile/v1/integrity/keys/route';
import {POST as revokeKey} from '../app/api/mobile/v1/integrity/revoke/route';
import {createIntegrityHttpHandlers} from '../lib/mobile-api/integrity-routes';
import {AuthRequiredError} from '../lib/auth-errors';
import {onlineClockClientData,type OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}};
let base:Base,caller:SessionContext,config:unknown|null,revoked=false;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>{if(revoked)throw new AuthRequiredError();return caller;}}));
const configuration=vi.fn(async(_ctx:SessionContext,_employmentId:string)=>config);
const api=createIntegrityHttpHandlers(configuration,async()=>{if(revoked)throw new AuthRequiredError();return caller;});
beforeAll(()=>vi.stubEnv('AI_CONFIG_SECRET','synthetic-mobile-key-receipt-secret-2026'));
beforeEach(async()=>{await resetDb();base=await seedBase();config=settings;revoked=false;configuration.mockClear();});
afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
async function employee(){
  const e=await hireEmployee(adminCtx(base),{person:{fullName:'HTTP integrity',primaryEmail:randomUUID()+'@http.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const userId=await createAppUser(base.tenantId,e.personId,'employee');
  const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
  return {...e,ctx};
}
async function enrolled(){
  const e=await employee(),{privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  const vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const enrollment=createAppleEnrollmentService(settings,{verifyProof:async()=>({publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},
    receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
  const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(e.ctx,intent);
  const key=await enrollment.complete(e.ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId,attestation:Buffer.from('synthetic')});
  const input={appInstallationId:intent.appInstallationId,keyId:key.keyId,command:{requestId:randomUUID(),action:'in',lat:3,lng:101,accuracy:4,sampledAt:Date.now()},
    evidence:{platform:'ios',appId:'ai.stradaverse.aihr.test',appVersion:'1.0',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
  caller=e.ctx;return {...e,privateKey,input};
}
function assertion(context:OnlineClockIntegrityData,privateKey:KeyObject){
  const authenticatorData=Buffer.alloc(37);createHash('sha256').update(settings.target.appId).digest().copy(authenticatorData);authenticatorData[32]=0x40;authenticatorData.writeUInt32BE(1,33);
  const nonce=createHash('sha256').update(authenticatorData).update(createHash('sha256').update(onlineClockClientData(context)).digest()).digest();
  return cbor.encode({authenticatorData,signature:sign('sha256',nonce,privateKey)}).toString('base64');
}
async function call(kind:keyof typeof api,employmentId:string,body?:unknown,options:{form?:boolean;extra?:Record<string,string>;photo?:Blob;query?:string}={}){
  const headers=new Headers(options.extra),init:RequestInit={method:body===undefined?'GET':'POST',headers};
  if(body!==undefined){
    if(options.form){const form=new FormData();form.set('command',JSON.stringify(body));if(options.photo)form.set('photo',options.photo,'private-name.jpg');init.body=form;}
    else {headers.set('content-type','application/json');init.body=JSON.stringify(body);}
  }
  const response=await api[kind](new Request('https://untrusted-host.example/api/mobile/v1/integrity/'+kind+'?employmentId='+employmentId+(options.query??''),init));
  return {status:response.status,headers:response.headers,body:await response.json()};
}
describe('bounded scoped integrity HTTP handlers before route activation',()=>{
  it('mounts own key recovery independently of vendor settings and receipt encryption availability',async()=>{
    const f=await enrolled();config=null;const secret=process.env.AI_CONFIG_SECRET;
    vi.stubEnv('AI_CONFIG_SECRET','');
    try{
      const url='https://hr.example/api/mobile/v1/integrity/keys?employmentId='+f.employmentId;
      const response=await ownKeys(new Request(url)),keys=await response.json();
      expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
      expect(keys.outcome).toBe('keys');expect(keys.items).toHaveLength(1);expect(keys.items[0].keyId).toBe(f.input.keyId);
      expect(Object.keys(keys.items[0]).sort()).toEqual(['appId','createdAt','environment','keyId','nativeKeyBinding','originChallengeId','platform','proofKind','revokedAt'].sort());
      const request=()=>new Request(url.replace('/keys?','/revoke?'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyId:f.input.keyId})});
      const revoked=await revokeKey(request()),receipt=await revoked.json();expect(revoked.status).toBe(200);expect(receipt.outcome).toBe('revoked');expect(receipt.key.revokedAt).not.toBeNull();
      expect(await (await revokeKey(request())).json()).toEqual(receipt);expect(configuration).not.toHaveBeenCalled();
    }finally{vi.stubEnv('AI_CONFIG_SECRET',secret);}
  });
  it('requires an explicit own selector on mounted recovery routes and never permits peer revocation',async()=>{
    const f=await enrolled(),peer=await employee();
    const url='https://hr.example/api/mobile/v1/integrity/keys';
    for(const query of ['', '?employmentId='+f.employmentId+'&employmentId='+f.employmentId,'?employmentId='+f.employmentId+'&tenantId='+base.tenantId])
      expect((await ownKeys(new Request(url+query))).status).toBe(400);
    caller=peer.ctx;
    expect(await (await ownKeys(new Request(url+'?employmentId='+f.employmentId))).json()).toEqual({outcome:'refused',code:'subject_unavailable'});
    const result=await revokeKey(new Request(url.replace('/keys','/revoke')+'?employmentId='+peer.employmentId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyId:f.input.keyId})}));
    expect(await result.json()).toEqual({outcome:'refused',code:'key_unavailable'});
    const [key]=await owner.db.select().from(schema.mobileIntegrityKey);expect(key.revokedAt).toBeNull();
  });
  it('applies bearer admission before mounted recovery reads and mutation parsing',async()=>{
    const f=await enrolled();revoked=true;
    for(const [handler,method,path] of [[ownKeys,'GET','keys'],[revokeKey,'POST','revoke']] as const){
      const response=await handler(new Request('https://hr.example/api/mobile/v1/integrity/'+path+'?employmentId='+f.employmentId,{method,...(method==='POST'?{body:'malformed'}:{})}));
      expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'auth_required'});expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const [key]=await owner.db.select().from(schema.mobileIntegrityKey);expect(key.revokedAt).toBeNull();
  });
  it('bounds mounted revocation inputs and refuses extra authority without changing the key',async()=>{
    const f=await enrolled(),url='https://hr.example/api/mobile/v1/integrity/revoke?employmentId='+f.employmentId;
    const payloads=[{keyId:f.input.keyId,tenantId:base.tenantId},{keyId:f.input.keyId,verified:true},{keyId:f.input.keyId,padding:'x'.repeat(257)}].map(value=>JSON.stringify(value));
    // Valid command schema with excessive wire whitespace: only the streaming byte cap refuses it.
    payloads.push(' '.repeat(257)+JSON.stringify({keyId:f.input.keyId}));
    for(const body of payloads){
      const response=await revokeKey(new Request(url,{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body}));expect(response.status).toBe(400);
    }
    const [key]=await owner.db.select().from(schema.mobileIntegrityKey);expect(key.revokedAt).toBeNull();
  });
  it('keeps mounted key recovery behind the attendance module service boundary',async()=>{
    const f=await enrolled();caller={...f.ctx,entitlements:{...harnessSnapshot(base.tenantId),enabledModules:[]}};
    const response=await ownKeys(new Request('https://hr.example/api/mobile/v1/integrity/keys?employmentId='+f.employmentId));
    expect(await response.json()).toEqual({outcome:'unavailable',code:'module_unavailable'});
  });
  it('uses deployment identity, explicit owned selection and minimal prepared enrollment bytes',async()=>{
    const e=await employee();caller=e.ctx;
    expect((await call('capabilities',e.employmentId)).body).toEqual({outcome:'capabilities',protocol:1,platform:'ios',features:['key_enrollment','online_clock_assertion'],offline:false});
    const intent={requestId:randomUUID(),appInstallationId:randomUUID()},a=await call('enrollmentBegin',e.employmentId.toUpperCase(),intent,{extra:{host:'forged.example','x-app-id':'forged'}});
    expect(a.status).toBe(200);expect(a.headers.get('cache-control')).toBe('no-store');
    expect(a.body).toMatchObject({outcome:'prepared',protocol:1,state:'active',context:{apiOrigin:settings.apiOrigin,actorId:e.ctx.userId,employmentId:e.employmentId,target:settings.target}});
    expect(a.body).not.toHaveProperty('challenge');expect(a.body).not.toHaveProperty('bindingHash');
    expect((await call('enrollmentBegin',e.employmentId,intent)).body).toEqual(a.body);
    expect(configuration).toHaveBeenCalledWith(expect.objectContaining({userId:e.ctx.userId}),e.employmentId,expect.any(AbortSignal));
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
  });
  it('rejects peer/admin selectors before configuration and client-supplied authority before issuance',async()=>{
    const a=await employee(),peer=await employee();caller=a.ctx;
    const intent={requestId:randomUUID(),appInstallationId:randomUUID()};
    expect((await call('enrollmentBegin',peer.employmentId,intent)).body).toEqual({outcome:'refused',code:'subject_unavailable'});
    caller=adminCtx(base);expect((await call('keys',a.employmentId)).body).toEqual({outcome:'refused',code:'subject_unavailable'});expect(configuration).not.toHaveBeenCalled();
    caller=a.ctx;
    for(const extra of [{tenantId:base.tenantId},{actorId:a.ctx.userId},{employmentId:a.employmentId},{settings},{clientDataHash:'A'.repeat(44)},{verified:true}])
      expect((await call('enrollmentBegin',a.employmentId,{...intent,...extra})).status).toBe(400);
    expect((await call('enrollmentBegin',a.employmentId,intent,{query:'&employmentId='+a.employmentId})).status).toBe(400);
    expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
  });
  it('bounds JSON and canonical base64, and maps malformed vendor proof to an expected refusal',async()=>{
    const e=await employee();caller=e.ctx;const intent={requestId:randomUUID(),appInstallationId:randomUUID()},begin=await call('enrollmentBegin',e.employmentId,intent);
    const input={...intent,challengeId:begin.body.context.challengeId,vendorKeyId:Buffer.alloc(32).toString('base64'),attestation:Buffer.from('not vendor CBOR').toString('base64')};
    const logged=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      expect((await call('enrollmentComplete',e.employmentId,input)).body).toEqual({outcome:'refused',code:'invalid_proof'});
      for(const attestation of ['AB==','A'.repeat(87388),'A'.repeat(100000)])
        expect((await call('enrollmentComplete',e.employmentId,{...input,attestation},{extra:{'content-length':'1'}})).status).toBe(400);
      expect(logged).not.toHaveBeenCalled();
    }finally{logged.mockRestore();}
    expect(await owner.db.select().from(schema.mobileIntegrityKey)).toHaveLength(0);
    const [challenge]=await owner.db.select().from(schema.mobileIntegrityChallenge);expect(challenge.consumedAt).toBeNull();
  });
  it('commits and recovers one real signed clock receipt through concurrent HTTP requests',async()=>{
    const f=await enrolled(),begin=await call('clockBegin',f.employmentId,f.input,{form:true});expect(begin.body.outcome).toBe('prepared');
    const proof={...f.input,challengeId:begin.body.context.challenge.id,assertion:assertion(begin.body.context,f.privateKey)};
    const [a,b]=await Promise.all([call('clockComplete',f.employmentId,proof,{form:true}),call('clockComplete',f.employmentId,proof,{form:true})]);
    expect(a.status).toBe(200);expect(a.body.outcome).toBe('accepted');expect(a.body).toEqual(b.body);
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);const [key]=await owner.db.select().from(schema.mobileIntegrityKey);expect(key.assertionCounter).toBe(1);
    expect(a.body.receipt).not.toHaveProperty('trustTier');expect(begin.body.context.scope.apiOrigin).toBe(settings.apiOrigin);
  });
  it('never falls back after invalid proof or changed command, and rejects multipart ambiguity',async()=>{
    const f=await enrolled(),begin=await call('clockBegin',f.employmentId,f.input,{form:true});
    const proof={...f.input,challengeId:begin.body.context.challenge.id,assertion:Buffer.from('malformed').toString('base64')};
    const logged=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      expect((await call('clockComplete',f.employmentId,proof,{form:true})).body).toEqual({outcome:'refused',code:'invalid_proof'});
      expect((await call('clockComplete',f.employmentId,{...proof,command:{...proof.command,lat:4}},{form:true})).body).toEqual({outcome:'refused',code:'binding_conflict'});
      expect((await call('clockComplete',f.employmentId,{...proof,tenantId:base.tenantId},{form:true})).status).toBe(400);
      expect((await call('clockBegin',f.employmentId,f.input,{form:true,photo:new Blob(['not an image'],{type:'text/plain'})})).status).toBe(400);
      const form=new FormData();form.append('command',JSON.stringify(proof));form.append('command',JSON.stringify(proof));
      expect((await api.clockComplete(new Request('https://hr.example.com/?employmentId='+f.employmentId,{method:'POST',body:form}))).status).toBe(400);
      expect(logged).not.toHaveBeenCalled();
    }finally{logged.mockRestore();}
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);const [key]=await owner.db.select().from(schema.mobileIntegrityKey);expect(key.assertionCounter).toBe(0);
  });
  it('keeps minimal own key inventory and revocation available when enrollment configuration is unavailable',async()=>{
    const f=await enrolled();config=null;
    expect((await call('capabilities',f.employmentId)).body).toEqual({outcome:'unavailable',code:'not_configured'});
    const keys=await call('keys',f.employmentId);expect(keys.body.outcome).toBe('keys');expect(keys.body.items).toHaveLength(1);
    expect(Object.keys(keys.body.items[0]).sort()).toEqual(['appId','createdAt','environment','keyId','nativeKeyBinding','originChallengeId','platform','proofKind','revokedAt'].sort());
    const revoked=await call('revoke',f.employmentId,{keyId:f.input.keyId});expect(revoked.body.outcome).toBe('revoked');expect(revoked.body.key.revokedAt).not.toBeNull();
    expect((await call('revoke',f.employmentId,{keyId:f.input.keyId})).body).toEqual(revoked.body);expect((await call('keys',f.employmentId)).body.items[0]).toEqual(revoked.body.key);
  });
  it('refuses a revoked bearer before body parsing or configuration access',async()=>{
    const e=await employee();caller=e.ctx;revoked=true;
    for(const kind of ['enrollmentBegin','enrollmentComplete','clockBegin','clockComplete','revoke'] as const){
      const result=await call(kind,e.employmentId,{bogus:'private body'});expect(result.status).toBe(401);expect(result.body).toEqual({error:'auth_required'});expect(result.headers.get('cache-control')).toBe('no-store');
    }
    expect(configuration).not.toHaveBeenCalled();expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);
  });
  it('fails unavailable on invalid server configuration without using request identity or logging expected refusals',async()=>{
    const e=await employee();caller=e.ctx;config={...settings,apiOrigin:'http://invalid.example'};
    const logged=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{expect((await call('capabilities',e.employmentId)).body).toEqual({outcome:'unavailable',code:'configuration_unavailable'});expect(logged).not.toHaveBeenCalled();}
    finally{logged.mockRestore();}
  });
  it('applies shared issuance admission and preserves a retained reference through capacity refusal',async()=>{
    const e=await employee();caller=e.ctx;const intent={requestId:randomUUID(),appInstallationId:randomUUID()},first=await call('enrollmentBegin',e.employmentId,intent);
    for(let i=0;i<3;i++)expect((await call('enrollmentBegin',e.employmentId,{...intent,requestId:randomUUID()})).status).toBe(200);
    const refused=await call('enrollmentBegin',e.employmentId,{...intent,requestId:randomUUID()});expect(refused.status).toBe(429);expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('enrollmentBegin',e.employmentId,intent)).body).toEqual(first.body);expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(4);
  });
  it.each(['timeout','abort','cooperative_abort'] as const)('stops issuance on configuration %s and ignores a late configuration result',async(mode)=>{
    const e=await employee();caller=e.ctx;let finish!:(value:unknown)=>void,entered!:()=>void,readSignal:AbortSignal|undefined;
    const started=new Promise<void>(resolve=>{entered=resolve;}),configuration=new Promise<unknown>(resolve=>{finish=resolve;});
    const delayed=createIntegrityHttpHandlers(async(_ctx,_id,signal)=>{
      readSignal=signal;entered();
      if(mode==='cooperative_abort')return new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(new Error('synthetic private configuration cancellation')),{once:true});configuration.then(resolve,reject);
      });
      return configuration;
    },async()=>e.ctx,{configurationTimeoutMs:50});
    const controller=new AbortController(),pending=delayed.enrollmentBegin(new Request('https://hr.example.com/?employmentId='+e.employmentId,{
      method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),appInstallationId:randomUUID()}),
    }));
    await started;if(mode!=='timeout')controller.abort();
    const response=await pending;expect(response.status).toBe(200);expect(await response.json()).toEqual({outcome:'unavailable',code:'configuration_unavailable'});
    expect(readSignal?.aborted).toBe(true);finish(settings);await new Promise(resolve=>setImmediate(resolve));
    expect(await owner.db.select().from(schema.mobileIntegrityChallenge)).toHaveLength(0);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
  });
  it('preserves a typed uncertainty reason without exposing raw error details or accepting a punch',async()=>{
    const f=await enrolled(),admin=adminCtx(base),site=await createClockingLocation(admin,{companyIds:[base.companyId],name:'HTTP office',lat:3,lng:101,radiusM:50});
    await setClockingControl(admin,{employmentId:f.employmentId,enabled:true,clockingLocationIds:[site.id]});
    await setAttendancePolicy(admin,{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5],geofenceMaximumAccuracyM:1});
    const begin=await call('clockBegin',f.employmentId,f.input,{form:true});
    const result=await call('clockComplete',f.employmentId,{...f.input,challengeId:begin.body.context.challenge.id,assertion:assertion(begin.body.context,f.privateKey)},{form:true});
    expect(result.body).toEqual({outcome:'refused',code:'location_required',locationReason:'poor_accuracy'});
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);const [key]=await owner.db.select().from(schema.mobileIntegrityKey);expect(key.assertionCounter).toBe(0);
  });
});
