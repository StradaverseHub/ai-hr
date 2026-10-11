import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {manualAccountProvider} from '../lib/identity/manual-provider';
import {ManualIdentityError,type ManualIdentityEnrollment} from '../lib/identity/manual-model';
const issuer='https://hr.test/identity/realms/ai-hr';
const e:ManualIdentityEnrollment={id:randomUUID(),tenant_id:randomUUID(),person_id:randomUUID(),created_by:randomUUID(),
 issuer,username:'manual.login',email:'manual@example.test',role:'employee',company_id:null,status:'prepared',subject:randomUUID(),app_user_id:null,created_at:new Date()};
let account:Record<string,unknown>|undefined,calls:{path:string;method:string;body:Record<string,unknown>|undefined}[];
let failure:'create-unknown'|'enable-unknown'|'password-policy'|undefined;
beforeEach(()=>{
 account=undefined;calls=[];failure=undefined;
 for(const [k,v]of Object.entries({AUTH_PROVIDER:'keycloak',AUTH_PUBLIC_ORIGIN:'https://hr.test',KEYCLOAK_ISSUER:issuer,
 KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'secret',KEYCLOAK_MOBILE_CLIENT_ID:'mobile',KEYCLOAK_API_AUDIENCE:'api',AUTH_SESSION_KEY:'f'.repeat(64),
 KEYCLOAK_ADMIN_CLIENT_ID:'invitations',KEYCLOAK_ADMIN_CLIENT_SECRET:'service-secret',KEYCLOAK_EMAIL_ENABLED:'false',KEYCLOAK_BACKCHANNEL_ORIGIN:'http://127.0.0.1:18080'}))vi.stubEnv(k,v);
 vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(String(input));expect(url.origin).toBe('http://127.0.0.1:18080');expect(init?.redirect).toBe('error');expect(init?.signal).toBeDefined();
  if(url.pathname.endsWith('/token'))return Response.json({access_token:'test-service-token'});
  const path=url.pathname.replace('/identity/admin/realms/ai-hr',''),method=init?.method??'GET';
  const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,body});
  expect(init?.headers).toMatchObject({authorization:'Bearer test-service-token'});
  if(path==='/users'&&method==='GET')return Response.json(account?[account]:[]);
  if(path==='/users'&&method==='POST'){
   account={id:e.subject,...body};if(failure==='create-unknown')throw new Error('untrusted provider error contains password');
   return new Response(null,{status:201,headers:{location:`http://127.0.0.1:18080/identity/admin/realms/ai-hr/users/${e.subject}`}});
  }
  if(path===`/users/${e.subject}`&&method==='GET')return account?Response.json(account):new Response(null,{status:404});
  if(path.endsWith('/reset-password')&&method==='PUT'){
   if(failure==='password-policy')return Response.json({error:'credential-bearing detail'},{status:400});
   account!.requiredActions=['UPDATE_PASSWORD'];return new Response(null,{status:204});
  }
  if(path===`/users/${e.subject}`&&method==='PUT'){
   Object.assign(account!,body);if(failure==='enable-unknown')throw new Error('lost write response');return new Response(null,{status:204});
  }
  if(path===`/users/${e.subject}`&&method==='DELETE'){account=undefined;return new Response(null,{status:204});}
  throw new Error('Unexpected provider path');
 }));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
async function create(){const p=manualAccountProvider();expect(await p.create({...e,subject:null,status:'reserved'})).toBe(e.subject);return p;}
describe('manual identity provider transport and credential boundary',()=>{
 it('creates a disabled account without a credential, sets a temporary password only on its exact ID, then enables with readback, independent of SMTP',async()=>{
  const p=await create();const post=calls.find(c=>c.method==='POST')!;
  expect(post.body).toMatchObject({username:e.username,email:e.email,emailVerified:true,enabled:false,requiredActions:['UPDATE_PASSWORD']});expect(post.body).not.toHaveProperty('credentials');
  await p.setPassword(e,'Private-password-12345');
  expect(calls.find(c=>c.path.endsWith('/reset-password'))?.body).toEqual({type:'password',value:'Private-password-12345',temporary:true});
  await p.enable({...e,status:'linked'});expect(account!.enabled).toBe(true);
  expect(calls.every(c=>!c.path.includes('execute-actions-email')&&!c.path.includes('testSMTP'))).toBe(true);
 });
 it('refuses existing usernames/emails even when disabled; no adoption, reset, enable or deletion',async()=>{
  account={id:'unrelated',username:e.username,email:e.email,enabled:false};
  await expect(manualAccountProvider().create(e)).rejects.toMatchObject({code:'conflict'});
  expect(calls.every(c=>c.method==='GET')).toBe(true);
 });
 it('never resolves an uncertain creation by searching and adopting the resulting account',async()=>{
  failure='create-unknown';const p=manualAccountProvider();
  await expect(p.create(e)).rejects.toMatchObject({code:'uncertain'});
  await expect(p.create(e)).rejects.toMatchObject({code:'conflict'});
  expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);expect(calls.some(c=>c.method==='PUT')).toBe(false);
 });
 it('refuses resets/deletion for enabled, mismatched and federated accounts and confines all operations to the configured issuer',async()=>{
  const p=await create();
  for(const change of [{enabled:true},{username:'other'},{email:'other@example.test'},{emailVerified:false},{federationLink:'external'},{serviceAccountClientId:'service'}]){
   const previous={...account};Object.assign(account!,change);
   await expect(p.setPassword(e,'Private-password-12345')).rejects.toMatchObject({code:'conflict'});
   await expect(p.cancel(e)).rejects.toMatchObject({code:'conflict'});account=previous;
  }
  await expect(p.create({...e,issuer:'https://evil.test/realms/hr'})).rejects.toMatchObject({code:'forbidden'});
  expect(calls.filter(c=>c.method==='PUT'||c.method==='DELETE')).toHaveLength(0);
 });
 it('reconciles a lost enable response, never resets an enabled password, and sanitizes password-policy errors',async()=>{
  const p=await create();failure='password-policy';
  const err=await p.setPassword(e,'Private-password-12345').catch(e=>e);expect(err).toBeInstanceOf(ManualIdentityError);expect(err.message).not.toContain('credential-bearing');
  failure='enable-unknown';await p.enable({...e,status:'linked'});await p.enable({...e,status:'linked'});
  expect(calls.filter(c=>c.path===`/users/${e.subject}`&&c.method==='PUT')).toHaveLength(1);
  await expect(p.setPassword(e,'Replacement-password-567')).rejects.toMatchObject({code:'conflict'});
 });
 it('cancels only its recorded disabled ID, verifies deletion and does not delete an unknown creation by username',async()=>{
  const p=await create();await p.cancel({...e,subject:null,status:'reserved'});expect(account).toBeDefined();
  await p.cancel(e);expect(account).toBeUndefined();await p.cancel(e);
  expect(calls.filter(c=>c.method==='DELETE')).toHaveLength(1);
 });
});
