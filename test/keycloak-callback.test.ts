import { NextRequest } from 'next/server';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ports=vi.hoisted(()=>({create:vi.fn(),remove:vi.fn(),succeeded:vi.fn(),blocked:vi.fn(),principal:vi.fn()}));
vi.mock('../lib/identity/session',()=>({createIdentitySession:ports.create,deleteIdentitySession:ports.remove,cookieOptions:{httpOnly:true,secure:true,sameSite:'lax',path:'/'}}));
vi.mock('../db/client',()=>({client:ports.principal}));
vi.mock('../core/auth',()=>({recordLoginSucceeded:ports.succeeded,recordLoginBlocked:ports.blocked}));
vi.mock('next-intl/server',()=>({getTranslations:async()=> (key:string)=>key}));
import { startKeycloakLogin, completeKeycloakLogin } from '../lib/identity/login';
import { LOGIN_COOKIE, WEB_SESSION_COOKIE } from '../lib/identity/config';

const issuer='https://identity.test/identity/realms/callback';
const key=await generateKeyPair('RS256',{extractable:true});
const jwk={...await exportJWK(key.publicKey),kid:'callback',alg:'RS256',use:'sig'};
let expectedNonce=''; let expectedChallenge=''; let consumed=false; let exchanges=0; let badNonce=false;
async function signed(extra:Record<string,unknown>,audience:string) {
  return new SignJWT(extra).setProtectedHeader({alg:'RS256',kid:'callback'}).setIssuer(issuer).setSubject('subject').setAudience(audience)
    .setIssuedAt().setExpirationTime('5m').sign(key.privateKey);
}
beforeEach(()=>{
  for(const [k,v] of Object.entries({AUTH_PROVIDER:'keycloak',AUTH_PUBLIC_ORIGIN:'https://hr.test',KEYCLOAK_ISSUER:issuer,KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'secret',
    KEYCLOAK_MOBILE_CLIENT_ID:'mobile',KEYCLOAK_API_AUDIENCE:'hr-api',AUTH_SESSION_KEY:'c'.repeat(64),KEYCLOAK_BACKCHANNEL_ORIGIN:''})) vi.stubEnv(k,v);
  ports.create.mockReset().mockResolvedValue('r'.repeat(43)); ports.remove.mockReset().mockResolvedValue(undefined);
  ports.succeeded.mockReset().mockResolvedValue(undefined);ports.blocked.mockReset().mockResolvedValue(undefined);ports.principal.mockReset().mockResolvedValue([{app_user_id:'internal-user',tenant_id:'tenant'}]);
  exchanges=0;consumed=false;badNonce=false;
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith('/.well-known/openid-configuration')) return Response.json({issuer,authorization_endpoint:`${issuer}/protocol/openid-connect/auth`,token_endpoint:`${issuer}/protocol/openid-connect/token`,
      jwks_uri:`${issuer}/protocol/openid-connect/certs`,end_session_endpoint:`${issuer}/protocol/openid-connect/logout`,revocation_endpoint:`${issuer}/protocol/openid-connect/revoke`,
      response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post'],code_challenge_methods_supported:['S256'],authorization_response_iss_parameter_supported:true});
    if(url.endsWith('/certs')) return Response.json({keys:[jwk]});
    if(url.endsWith('/token')) {
      exchanges++;
      const params=new URLSearchParams(String(init?.body));
      expect(params.get('redirect_uri')).toBe('https://hr.test/callback');expect(params.get('client_secret')).toBe('secret');
      const {createHash}=await import('node:crypto');
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(expectedChallenge);
      if(consumed) return Response.json({error:'invalid_grant'},{status:400});
      consumed=true;
      return Response.json({token_type:'Bearer',expires_in:300,refresh_token:'refresh',
        access_token:await signed({typ:'Bearer',azp:'web'},'hr-api'),id_token:await signed({nonce:badNonce?'wrong':expectedNonce,email:'owner@example.test',email_verified:true},'web')});
    }
    throw new Error('Unexpected identity endpoint');
  }));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
async function attempt(returnTo='/people') {
  const start=await startKeycloakLogin(new NextRequest(`https://forged.test/login/start?returnTo=${encodeURIComponent(returnTo)}`));
  const url=new URL(start.headers.get('location')!);expectedNonce=url.searchParams.get('nonce')!;expectedChallenge=url.searchParams.get('code_challenge')!;
  const transaction=start.cookies.get(LOGIN_COOKIE)!;
  const callback=(state=url.searchParams.get('state')!,iss=issuer)=>new NextRequest(`https://forged.test/callback?${new URLSearchParams({code:'one-time-code',state,iss})}`,{headers:{cookie:`${LOGIN_COOKIE}=${transaction.value}; ${WEB_SESSION_COOKIE}=old-cookie`}});
  return {start,url,callback};
}
describe('web OIDC round trip — maintained code/state/nonce/PKCE implementation',()=>{
  it('sets a bounded Secure HttpOnly login transaction, exchanges once and rotates the session',async()=>{
    const f=await attempt('/people?tab=team');
    expect(f.url.origin).toBe('https://identity.test');expect(f.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(f.start.cookies.get(LOGIN_COOKIE)).toMatchObject({httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600});
    const result=await completeKeycloakLogin(f.callback());
    expect(result.status).toBe(307);expect(result.headers.get('location')).toBe('https://hr.test/people?tab=team');
    expect(result.cookies.get(WEB_SESSION_COOKIE)).toMatchObject({value:'r'.repeat(43),httpOnly:true,secure:true,sameSite:'lax'});
    expect(result.cookies.get(LOGIN_COOKIE)?.maxAge).toBe(0);expect(result.headers.get('cache-control')).toBe('no-store');
    expect(ports.remove).toHaveBeenCalledWith('old-cookie');expect(ports.create).toHaveBeenCalledWith(expect.objectContaining({issuer,subject:'subject',emailVerified:true}));
    expect(ports.succeeded).toHaveBeenCalledWith({userId:'internal-user',tenantId:'tenant'});
    const replay=await completeKeycloakLogin(f.callback());expect(replay.status).toBe(400);expect(ports.create).toHaveBeenCalledTimes(1);
  });
  it('rejects missing transaction, wrong state and issuer mix-up before token exchange',async()=>{
    expect((await completeKeycloakLogin(new NextRequest('https://hr.test/callback?code=forged'))).status).toBe(400);
    const f=await attempt();
    expect((await completeKeycloakLogin(f.callback('wrong-state'))).status).toBe(400);
    expect((await completeKeycloakLogin(f.callback(undefined,'https://evil.test/realm'))).status).toBe(400);
    expect(exchanges).toBe(0);expect(ports.create).not.toHaveBeenCalled();
  });
  it('rejects an ID token nonce mismatch without issuing an app session',async()=>{
    const f=await attempt();badNonce=true;
    expect((await completeKeycloakLogin(f.callback())).status).toBe(400);expect(exchanges).toBe(1);expect(ports.create).not.toHaveBeenCalled();
  });
  it('uses an internal return path and records an unlinked identity without granting any HR access',async()=>{
    const f=await attempt('//evil.test');ports.principal.mockResolvedValue([]);
    const result=await completeKeycloakLogin(f.callback());
    expect(result.headers.get('location')).toBe('https://hr.test/');expect(ports.blocked).toHaveBeenCalledOnce();expect(ports.succeeded).not.toHaveBeenCalled();
  });
});
