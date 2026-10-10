import { sealSessionHandle } from '../lib/identity/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const p=vi.hoisted(()=>({cookie:vi.fn(),set:vi.fn(),transaction:vi.fn(),sql:vi.fn(),revoke:vi.fn(),build:vi.fn(),client:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:p.cookie,set:p.set})}));
vi.mock('../db/client',()=>({client:Object.assign(p.sql,{begin:p.transaction})}));
vi.mock('../lib/identity/oidc',()=>({oidcClient:p.client,verifyKeycloakAccessToken:vi.fn(),oidc:{tokenRevocation:p.revoke,buildEndSessionUrl:p.build}}));
import { endIdentitySession } from '../lib/identity/session';
import { seal } from '../lib/identity/seal';
import { sessionHash } from '../lib/identity/session';
import { WEB_SESSION_COOKIE } from '../lib/identity/config';
const issuer='https://id.test/identity/realms/logout';
beforeEach(async()=>{
  for (const [k,v] of Object.entries({KEYCLOAK_ISSUER:issuer,AUTH_PUBLIC_ORIGIN:'https://hr.test',KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'secret',KEYCLOAK_MOBILE_CLIENT_ID:'mobile',KEYCLOAK_API_AUDIENCE:'api',AUTH_SESSION_KEY:'e'.repeat(64)}))vi.stubEnv(k,v);
  vi.clearAllMocks();p.cookie.mockReturnValue({value:await sealSessionHandle('x'.repeat(43))});p.sql.mockResolvedValue([]);p.client.mockResolvedValue({});
  p.build.mockReturnValue(new URL('https://id.test/logout'));p.revoke.mockResolvedValue(undefined);
});
afterEach(()=>vi.unstubAllEnvs());
async function target() {
  const result=await endIdentitySession().then(()=>null,e=>e);
  return result?.digest?.split(';')[2];
}
describe('Keycloak logout',()=>{
  it('clears the browser cookie and returns a signed-out landing page during a storage outage',async()=>{
    p.transaction.mockRejectedValueOnce(new Error('database down'));p.sql.mockRejectedValueOnce(new Error('database down'));
    expect(await target()).toBe('https://hr.test/login?signedOut=1');
    expect(p.set).toHaveBeenCalledWith(WEB_SESSION_COOKIE,'',expect.objectContaining({maxAge:0,httpOnly:true,secure:true}));
    expect(p.revoke).not.toHaveBeenCalled();
  });
  it('still attempts browser SSO logout when token revocation is unavailable',async()=>{
    const sealed=await seal({issuer,subject:'subject',email:null,emailVerified:true,accessToken:'access',refreshToken:'refresh',idToken:'id',accessExpiry:100},`session:${sessionHash('x'.repeat(43))}`,Math.floor(Date.now()/1000)+600);
    p.transaction.mockImplementation(async run=>run(async()=>[{sealed,expires_at:new Date(Date.now()+600000)}]));
    p.revoke.mockRejectedValueOnce(new Error('outage'));
    expect(await target()).toBe('https://id.test/logout');
    expect(p.build).toHaveBeenCalledWith({},expect.objectContaining({post_logout_redirect_uri:'https://hr.test/login?signedOut=1',id_token_hint:'id'}));
    expect(p.sql).toHaveBeenCalled();expect(p.set).toHaveBeenCalled();
  });
});
