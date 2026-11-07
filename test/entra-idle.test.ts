import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {client,withPoolWork} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {provisionEntraTestOrganization} from './entra-fixture';
import {saveConnector} from '../lib/entra/store';
import {createEntraSession,readEntraSession,touchEntraSession,rotateEntraRefresh,revokeEntraSession} from '../lib/entra/sessions';
import {issuerFor,type EntraConfig} from '../lib/entra/model';
import {digest} from '../lib/internal-auth/crypto';
import {readRecord,writeRecord} from '../lib/internal-auth/store';
import {saveSessionPolicy} from '../core/session-policy';
import {forgetIdleTimeout} from '../lib/session-policy-server';
import {POST} from '../app/login/api/[operation]/route';
const requestCookie=vi.hoisted(()=>({token:undefined as string|undefined}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='__Host-aihr_internal'&&requestCookie.token?{value:requestCookie.token}:undefined})}));
let base:Base,config:EntraConfig,object:string,now:number;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 requestCookie.token=undefined;await resetDb();base=await seedBase();forgetIdleTimeout(base.tenantId);
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','6'.repeat(64));vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE','0');
 await provisionEntraTestOrganization(base,'acme');
 config={tenantId:base.tenantId,organization:'acme',directoryTenantId:randomUUID(),clientId:randomUUID(),clientSecret:'fixture',provisioningClientId:'',provisioningClientSecret:'',servicePrincipalId:'',jobId:'',sourceAnchorAttribute:'',domain:'',mode:'cloud',enabled:true,provisioningEnabled:false,immutableMatchingConfirmed:false,revision:randomUUID()};
 await saveConnector(adminCtx(base),config,null);object=randomUUID();
 await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuerFor(config.directoryTenantId)},${object},${base.adminUserId})`;
 now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(closeAll);
const advance=(minutes:number)=>{now+=minutes*60_000;};
async function policy(minutes:number){await saveSessionPolicy({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},minutes,0);forgetIdleTimeout(base.tenantId);}
describe('combined Microsoft sign-in and shared idle-session policy',()=>{
 it.each(['web-read','web-touch','native-read','refresh','logout','refresh-only-logout'] as const)('admits %s before any raw SQL while preserving the real native outcome',async operation=>{
  const native=!operation.startsWith('web-'),session=await createEntraSession(config,object,native);
  let release!:()=>void,admitted!:()=>void,started=0;
  const held=new Promise<void>(done=>{release=done;}),ready=new Promise<void>(done=>{admitted=done;});
  const holders=Array.from({length:client.options.max},(_,i)=>withPoolWork(`entra-admission-fixture-${i}`,async()=>{
   if(++started===client.options.max)admitted();await held;
  }));
  let request:Promise<unknown>|undefined;
  try{
   await Promise.race([ready,Promise.all(holders).then(()=>{throw Error('Admission holders ended before the pool was held');})]);
   const rawSql=vi.spyOn(client,'unsafe');
   request=operation==='web-touch'?touchEntraSession(session.access_token):operation==='refresh'?rotateEntraRefresh(session.refresh_token!):
    operation==='logout'?revokeEntraSession(session.access_token,true):operation==='refresh-only-logout'?revokeEntraSession(undefined,true,session.refresh_token):readEntraSession(session.access_token,native);
   let settled=false;void request.then(()=>{settled=true;},()=>{settled=true;});
   await new Promise<void>(done=>setImmediate(done));
   expect(rawSql).not.toHaveBeenCalled();expect(settled).toBe(false);
   release();await Promise.all(holders);const result=await request;
   if(operation==='web-touch')expect(result).toMatchObject({idleTimeoutSeconds:900,remainingSeconds:900});
   else if(operation==='refresh'){
    expect(result).toMatchObject({step:'complete'});
    expect(await readEntraSession((result as {access_token:string}).access_token,true)).toMatchObject({subject:object});
   }else if(operation.endsWith('logout'))expect(await readEntraSession(session.access_token,true)).toBeNull();
   else expect(result).toMatchObject({issuer:issuerFor(config.directoryTenantId),subject:object});
  }finally{
   release();await Promise.allSettled([...holders,...(request?[request]:[])]);
  }
 },20000);
 it('keeps a fresh Microsoft cookie on the real activity endpoint rather than returning 401 within seconds',async()=>{
  const session=await createEntraSession(config,object,false);now+=5000;
  const response=await POST(new NextRequest('https://hr.test/login/api/activity',{method:'POST',headers:{origin:'https://hr.test','content-type':'application/json',cookie:`__Host-aihr_internal=${session.access_token}`},body:'{}'}),{params:Promise.resolve({operation:'activity'})});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({step:'active',idleTimeoutSeconds:900,remainingSeconds:895});
  expect(response.cookies.get('__Host-aihr_internal')).toBeUndefined();expect(await readEntraSession(session.access_token)).not.toBeNull();
 });
 it('returns expired through the shared provider contract after Microsoft reaches the organization limit',async()=>{
  const session=await createEntraSession(config,object,false);requestCookie.token=session.access_token;advance(16);
  const response=await POST(new NextRequest('https://hr.test/login/api/activity',{method:'POST',headers:{origin:'https://hr.test',cookie:`__Host-aihr_internal=${session.access_token}`}}),{params:Promise.resolve({operation:'activity'})});
  expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'expired'});
  expect(response.cookies.get('__Host-aihr_internal')?.value).toBe('');expect(await readEntraSession(session.access_token)).toBeNull();
  const events=await owner.client`select event_type from domain_event where tenant_id=${base.tenantId} and event_type='app-user.session-idle-expired'`;
  expect(events).toEqual([{event_type:'app-user.session-idle-expired'}]);
 });
 it('touches only on reported activity and atomically expires and audits the Microsoft family once',async()=>{
  const session=await createEntraSession(config,object,false);advance(10);
  expect(await touchEntraSession(session.access_token)).toEqual({idleTimeoutSeconds:900,remainingSeconds:900});
  advance(14);expect(await readEntraSession(session.access_token)).not.toBeNull();advance(2);
  expect(await Promise.all([readEntraSession(session.access_token),readEntraSession(session.access_token),touchEntraSession(session.access_token)])).toEqual([null,null,null]);
  const events=await owner.client`select actor_type,actor_id from domain_event where tenant_id=${base.tenantId} and event_type='app-user.session-idle-expired'`;
  expect(events).toEqual([{actor_type:'system',actor_id:null}]);expect(await touchEntraSession(session.access_token)).toBeNull();
 });
 it('uses the configured 30-minute policy and initializes an older Microsoft session without immediate logout',async()=>{
  await policy(30);const session=await createEntraSession(config,object,false),key=`entra-session:${digest(session.access_token)}`;
  const value=await readRecord<Record<string,unknown>>(client,key);const {lastActivity:ignored,...legacy}=value!;
  await writeRecord(client,key,legacy,null,legacy.expiry as number);advance(40);
  expect(await readEntraSession(session.access_token)).not.toBeNull();expect((await touchEntraSession(session.access_token))?.idleTimeoutSeconds).toBe(1800);
  advance(29);expect(await readEntraSession(session.access_token)).not.toBeNull();advance(2);expect(await readEntraSession(session.access_token)).toBeNull();
 });
 it('preserves the web-only idle contract for native Microsoft sessions',async()=>{
  await policy(5);const session=await createEntraSession(config,object,true);advance(6);
  expect(await readEntraSession(session.access_token,true)).not.toBeNull();expect(await touchEntraSession(session.access_token)).toBeNull();
 });
});
