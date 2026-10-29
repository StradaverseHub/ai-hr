import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {GET} from '../app/email-assets/[token]/route';
const storage=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('@/db/client',()=>({db:{execute:storage.execute}}));
const token='a1'.repeat(32),path='/email-assets/'+token,origin='https://hr.example.test';
const internal={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:origin,AUTH_SESSION_KEY:'a'.repeat(64)};
const keycloak={...internal,AUTH_PROVIDER:'keycloak',KEYCLOAK_ISSUER:origin+'/identity/realms/ai-hr',KEYCLOAK_WEB_CLIENT_ID:'fixture-web',KEYCLOAK_WEB_CLIENT_SECRET:'fixture-secret',KEYCLOAK_MOBILE_CLIENT_ID:'fixture-mobile',KEYCLOAK_API_AUDIENCE:'fixture-api'};
const workos={AUTH_PROVIDER:'workos',WORKOS_API_KEY:'sk_test_fixture',WORKOS_CLIENT_ID:'client_fixture',WORKOS_COOKIE_PASSWORD:'fixture-cookie-password-at-least-32-characters',NEXT_PUBLIC_WORKOS_REDIRECT_URI:origin+'/callback'};
function environment(values:Record<string,string>){
 for(const key of ['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','AUTH_SESSION_KEY','SHARE_PASSWORD','ALLOW_DEMO_SESSION',...Object.keys(keycloak),...Object.keys(workos)])vi.stubEnv(key,'');
 vi.stubEnv('NODE_ENV','production');for(const [key,value]of Object.entries(values))vi.stubEnv(key,value);
}
async function gate(route=path,method='GET'){
 const {middleware}=await import('../middleware');
 return middleware(new NextRequest(origin+route,{method}));
}
beforeEach(()=>{vi.resetModules();storage.execute.mockReset();});
afterEach(()=>vi.unstubAllEnvs());
describe('anonymous email raster asset boundary',()=>{
 it.each([['internal',internal],['keycloak',keycloak],['workos',workos],['demo',{SHARE_PASSWORD:'fixture-demo-password'}]] as const)('permits exact GET/HEAD assets with configured %s while protecting malformed paths, writes and the designer',async(_provider,settings)=>{
  environment(settings);
  for(const method of ['GET','HEAD']){const result=await gate(path,method);expect(result.status).toBe(200);expect(result.headers.get('x-middleware-next')).toBe('1');expect(result.headers.get('location')).toBeNull();expect(result.headers.get('www-authenticate')).toBeNull();}
  for(const route of ['/email-assets','/email-assets/'+token.slice(1),'/email-assets/'+token.toUpperCase(),'/email-assets/%61'+token.slice(1),path+'/',path+'/download','/admin/settings/email-templates'])expect((await gate(route)).headers.get('x-middleware-next')).not.toBe('1');
  expect((await gate(path,'POST')).headers.get('x-middleware-next')).not.toBe('1');expect(storage.execute).not.toHaveBeenCalled();
 });
 it.each([['internal missing key',{...internal,AUTH_SESSION_KEY:''}],['keycloak missing secret',{...keycloak,KEYCLOAK_WEB_CLIENT_SECRET:''}],['unknown provider',{AUTH_PROVIDER:'unknown'}],['unconfigured',{}]] as const)('retains fail-closed readiness for %s',async(_name,settings)=>{
  environment(settings);const result=await gate();expect(result.status).toBe(503);expect(result.headers.get('x-middleware-next')).toBeNull();expect(storage.execute).not.toHaveBeenCalled();
 });
 it('serves the exact raster bytes and immutable security headers after an anonymous request reaches the actual handler',async()=>{
  environment(internal);expect((await gate()).headers.get('x-middleware-next')).toBe('1');
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);storage.execute.mockResolvedValue([{mime:'image/png',bytes}]);
  const result=await GET(new Request(origin+path),{params:Promise.resolve({token})});
  expect(result.status).toBe(200);expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(bytes));expect(result.headers.get('content-type')).toBe('image/png');expect(result.headers.get('cache-control')).toBe('public,max-age=31536000,immutable');expect(result.headers.get('x-content-type-options')).toBe('nosniff');expect(result.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");expect(result.headers.get('location')).toBeNull();expect(storage.execute).toHaveBeenCalledTimes(1);
 });
 it('does not query storage for malformed tokens and returns no content for unknown valid tokens',async()=>{
  const invalid=await GET(new Request(origin+'/email-assets/invalid'),{params:Promise.resolve({token:'invalid'})});expect(invalid.status).toBe(404);expect(storage.execute).not.toHaveBeenCalled();
  storage.execute.mockResolvedValue([]);const missing=await GET(new Request(origin+path),{params:Promise.resolve({token})});expect(missing.status).toBe(404);expect(await missing.text()).toBe('');expect(missing.headers.get('location')).toBeNull();
 });
});
