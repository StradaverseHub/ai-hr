import { provisionEntraTestOrganization } from './entra-fixture';
import { randomUUID,createHash } from 'node:crypto';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import { client } from '../db/client';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import { saveConnector } from '../lib/entra/store';
import { type EntraConfig,issuerFor } from '../lib/entra/model';
import { startEntraLogin,completeEntraLogin,nativeLaunch,exchangeNative,callbackUri } from '../lib/entra/login';
import { readEntraSession } from '../lib/entra/sessions';
let base:Base,config:EntraConfig,key:Awaited<ReturnType<typeof generateKeyPair>>,nonce='',wrongTenant=false;
beforeAll(async()=>{await migrateTestDb();key=await generateKeyPair('RS256');});
beforeEach(async()=>{
 await resetDb();base=await seedBase();nonce='';wrongTenant=false;
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));
 config={tenantId:base.tenantId,organization:'acme',directoryTenantId:randomUUID(),clientId:randomUUID(),clientSecret:'secret',provisioningClientId:randomUUID(),provisioningClientSecret:'secret',servicePrincipalId:randomUUID(),jobId:'job-1',mode:'cloud',domain:'acme.test',sourceAnchorAttribute:'extension_'+'a'.repeat(32)+'_hrSourceId',enabled:true,provisioningEnabled:false,immutableMatchingConfirmed:true,revision:randomUUID()};
 await provisionEntraTestOrganization(base,config.organization);
 await saveConnector(adminCtx(base),config,null);
 const object='11111111-1111-4111-8111-111111111111';
 await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${issuerFor(config.directoryTenantId)},${object},${base.adminUserId})`;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
   const url=String(input);
   if(url.includes('.well-known/openid-configuration'))return Response.json({issuer:issuerFor(config.directoryTenantId),authorization_endpoint:`https://login.microsoftonline.com/${config.directoryTenantId}/oauth2/v2.0/authorize`,token_endpoint:`https://login.microsoftonline.com/${config.directoryTenantId}/oauth2/v2.0/token`,jwks_uri:'https://login.microsoftonline.com/common/discovery/v2.0/keys',response_types_supported:['code'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post']});
   if(url.endsWith('/keys'))return Response.json({keys:[{...await exportJWK(key.publicKey),kid:'fixture',use:'sig',alg:'RS256'}]});
   if(url.endsWith('/token'))return Response.json({access_token:'not-an-HR-token',token_type:'Bearer',expires_in:3600,id_token:await new SignJWT({tid:wrongTenant?randomUUID():config.directoryTenantId,oid:object,nonce}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(issuerFor(config.directoryTenantId)).setAudience(config.clientId).setSubject('pairwise-protocol-subject').setIssuedAt().setExpirationTime('5m').sign(key.privateKey)});
   throw Error('Unexpected external request');
 }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});afterAll(closeAll);
function response(start:{url:string},state?:string){const auth=new URL(start.url);nonce=auth.searchParams.get('nonce')!;const callback=new URL(callbackUri());callback.searchParams.set('code','fixture');callback.searchParams.set('state',state??auth.searchParams.get('state')!);return callback;}
describe('Microsoft login with real OIDC validation and exact HR bindings',()=>{
 it('creates an opaque HR browser session from a valid signed Microsoft response and refuses callback replay',async()=>{
  const flow=await startEntraLogin('acme','/me');const result=await completeEntraLogin(flow.handle,response(flow));
  expect(result.native).toBe(false);if(result.native)throw Error();expect(result.tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.redirect).toBe('https://hr.test/me');expect(await readEntraSession(result.tokens.access_token)).toMatchObject({subject:'11111111-1111-4111-8111-111111111111'});
  await expect(completeEntraLogin(flow.handle,response(flow))).rejects.toThrow();
 });
 it('refuses wrong state and wrong tenant despite a correctly signed response',async()=>{
  const flow=await startEntraLogin('acme','/');await expect(completeEntraLogin(flow.handle,response(flow,'wrong-state'))).rejects.toThrow();
  wrongTenant=true;const next=await startEntraLogin('acme','/');await expect(completeEntraLogin(next.handle,response(next))).rejects.toThrow();
 });
 it('returns a proof-bound one-use code to mobile and never puts session or Microsoft tokens in the deep link',async()=>{
  const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
  const launch=new URL(await nativeLaunch('acme',{redirect:'aihr://auth/callback',state:'s'.repeat(32),challenge}));
  const flow=await startEntraLogin('','/',launch.searchParams.get('ticket')!);const result=await completeEntraLogin(flow.handle,response(flow));
  expect(result.native).toBe(true);const callback=new URL(result.redirect);expect([...callback.searchParams.keys()].sort()).toEqual(['code','state']);
  const code=callback.searchParams.get('code')!;await expect(exchangeNative(code,'w'.repeat(64))).rejects.toThrow();
  const tokens=await exchangeNative(code,verifier);expect(await readEntraSession(tokens.access_token,true)).not.toBeNull();await expect(exchangeNative(code,verifier)).rejects.toThrow();
 });
 it('cannot switch the native destination to a foreign scheme or URL',async()=>{
  await expect(nativeLaunch('acme',{redirect:'https://evil.test/collect',state:'s'.repeat(32),challenge:'c'.repeat(43)})).rejects.toThrow();
 });
});
