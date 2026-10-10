import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keycloakConfig, safeReturnTo, WEB_SESSION_COOKIE } from '../lib/identity/config';
import { identityFetch, oidcClient, verifyKeycloakAccessToken } from '../lib/identity/oidc';
import { seal, unseal } from '../lib/identity/seal';
import { demoSwitcherEnabled } from '../lib/demo-mode';
import { middleware } from '../middleware';
import { AuthRequiredError } from '../lib/auth-errors';
import { JwksUnavailableError } from '../lib/mobile-api/jwt';
import { realmDefinition, INITIAL_SYSTEM_ADMIN_EMAIL } from '../deploy/keycloak/realm';

const issuer = 'https://identity.test/identity/realms/hr';
const settings = { AUTH_PROVIDER: 'keycloak', AUTH_PUBLIC_ORIGIN: 'https://hr.test', KEYCLOAK_ISSUER: issuer,
  KEYCLOAK_WEB_CLIENT_ID: 'web', KEYCLOAK_WEB_CLIENT_SECRET: 'server-secret', KEYCLOAK_MOBILE_CLIENT_ID: 'mobile',
  KEYCLOAK_API_AUDIENCE: 'hr-api', AUTH_SESSION_KEY: 'a'.repeat(64) };
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(keys.publicKey), kid: 'k1', alg: 'RS256', use: 'sig' };
async function jwt(claims: Record<string, unknown> = {}, key = keys.privateKey) {
  return new SignJWT({ typ: 'Bearer', azp: 'mobile', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('external-user').setIssuer(issuer).setAudience('hr-api').setIssuedAt().setExpirationTime('5m').sign(key);
}
beforeEach(() => { for (const [k,v] of Object.entries(settings)) vi.stubEnv(k,v); vi.stubEnv('KEYCLOAK_BACKCHANNEL_ORIGIN',''); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Keycloak trust boundaries', () => {
  it.each(['http://identity.test/realms/hr', 'https://user:pass@identity.test/realms/hr', 'https://identity.test/realms/hr?override=1', 'https://identity.test/realms/hr/'])('refuses an unsafe issuer: %s', value => {
    expect(() => keycloakConfig({ ...settings, KEYCLOAK_ISSUER: value })).toThrow();
  });
  it('allows only an explicitly configured loopback backchannel', () => {
    expect(keycloakConfig({ ...settings, KEYCLOAK_BACKCHANNEL_ORIGIN: 'http://127.0.0.1:8080' }).backchannel).toBe('http://127.0.0.1:8080');
    expect(() => keycloakConfig({ ...settings, KEYCLOAK_BACKCHANNEL_ORIGIN: 'http://10.0.0.1' })).toThrow();
  });
  it.each(['//evil.test', '/\\evil.test', 'https://evil.test', '/callback', '/login/start', '/\nmalicious'])('return target %j stays inside the app', value => expect(safeReturnTo(value)).toBe('/'));
  it('preserves a legitimate invitation return path and query', () => expect(safeReturnTo('/invite/token/activate?lang=ms')).toBe('/invite/token/activate?lang=ms'));
  it('pins outgoing identity requests and refuses redirects', async () => {
    const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const transport = identityFetch(keycloakConfig({ ...settings, KEYCLOAK_BACKCHANNEL_ORIGIN: 'http://127.0.0.1:8080' }),fake);
    await transport(`${issuer}/protocol/openid-connect/token`, { method: 'POST', body: 'secret=server-only' });
    expect(String(fake.mock.calls[0][0])).toBe('http://127.0.0.1:8080/identity/realms/hr/protocol/openid-connect/token');
    expect(fake.mock.calls[0][1]?.redirect).toBe('error');
    await expect(transport('https://evil.test/token')).rejects.toThrow('Unapproved');
    await expect(transport('https://identity.test/identity/realms/other/token')).rejects.toThrow('Unapproved');
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it('rejects malicious discovery before a code or client secret can be sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ issuer, authorization_endpoint: 'https://evil.test/auth', token_endpoint: 'https://evil.test/token', jwks_uri: 'https://evil.test/certs' })));
    await expect(oidcClient()).rejects.toThrow('Unapproved');
  });
  it('encrypts credentials and binds the ciphertext to purpose, issuer and expiry', async () => {
    const value = await seal({ refreshToken: 'very-secret' }, 'login', Math.floor(Date.now()/1000)+60);
    expect(value).not.toContain('very-secret');
    expect((await unseal(value,'login')).refreshToken).toBe('very-secret');
    await expect(unseal(value,'session:another')).rejects.toThrow();
    vi.stubEnv('KEYCLOAK_ISSUER', 'https://identity.test/identity/realms/other');
    await expect(unseal(value,'login')).rejects.toThrow();
    vi.stubEnv('KEYCLOAK_ISSUER',issuer);
    const expired = await seal({}, 'login', Math.floor(Date.now()/1000)-1);
    await expect(unseal(expired,'login')).rejects.toThrow();
  });
});
describe('Keycloak API access tokens', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [jwk] }))); });
  it('accepts the approved mobile and web access-token profiles', async () => {
    expect((await verifyKeycloakAccessToken(await jwt())).subject).toBe('external-user');
    expect((await verifyKeycloakAccessToken(await jwt({ azp:'web' }))).issuer).toBe(issuer);
  });
  it.each([{ typ:'ID' }, { azp:'another-client' }, { typ:undefined }, { azp:undefined }])('rejects signed but unapproved token claims %j', async claims => {
    await expect(verifyKeycloakAccessToken(await jwt(claims))).rejects.toBeInstanceOf(AuthRequiredError);
  });
  it('rejects another issuer, API, expired token, future issuance and forged signature', async () => {
    const base = () => new SignJWT({ typ:'Bearer',azp:'mobile' }).setProtectedHeader({alg:'RS256',kid:'k1'}).setSubject('external-user').setIssuedAt();
    for (const builder of [base().setIssuer('https://evil.test/realms/hr').setAudience('hr-api').setExpirationTime('5m'),
      base().setIssuer(issuer).setAudience('other-api').setExpirationTime('5m'),
      base().setIssuer(issuer).setAudience('hr-api').setExpirationTime(Math.floor(Date.now()/1000)-60),
      base().setIssuer(issuer).setAudience('hr-api').setExpirationTime('10m').setIssuedAt(Math.floor(Date.now()/1000)+120)]) {
      await expect(verifyKeycloakAccessToken(await builder.sign(keys.privateKey))).rejects.toBeInstanceOf(AuthRequiredError);
    }
    const other = await generateKeyPair('RS256');
    await expect(verifyKeycloakAccessToken(await jwt({},other.privateKey))).rejects.toBeInstanceOf(AuthRequiredError);
  });
  it('distinguishes provider outage from bad credentials', async () => {
    vi.stubEnv('KEYCLOAK_ISSUER', 'https://identity.test/identity/realms/outage');
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    await expect(verifyKeycloakAccessToken(await jwt())).rejects.toBeInstanceOf(JwksUnavailableError);
  });
});
describe('Keycloak middleware and realm policy', () => {
  it('disables demo switching even in development with the demo flag present', () => {
    vi.stubEnv('NODE_ENV','development'); vi.stubEnv('ALLOW_DEMO_SESSION','true');
    expect(demoSwitcherEnabled()).toBe(false);
  });
  it('redirects signed-out pages to the configured public login origin, not Host', async () => {
    const result = await middleware(new NextRequest('https://forged.test/people?tab=team'));
    const location = new URL(result.headers.get('location')!);
    expect(location.origin).toBe('https://hr.test'); expect(location.pathname).toBe('/login/start');
    expect(location.searchParams.get('returnTo')).toBe('/people?tab=team');
  });
  it('never redirects actions or API callers, and does not trust forged provider headers', async () => {
    expect((await middleware(new NextRequest('https://hr.test/people',{headers:{'next-action':'fake'}}))).status).toBe(401);
    const req = new NextRequest('https://hr.test/people',{ headers:{ cookie:`${WEB_SESSION_COOKIE}=opaque`, 'x-workos-session':'forged' } });
    const result = await middleware(req);
    expect(result.headers.get('x-middleware-next')).toBe('1');
    expect(result.headers.get('x-middleware-request-x-workos-session')).toBeNull();
  });
  it('an incomplete Keycloak configuration cannot fall back to the password gate', async () => {
    vi.stubEnv('SHARE_PASSWORD','demo'); vi.stubEnv('AUTH_SESSION_KEY','');
    expect((await middleware(new NextRequest('https://hr.test/health'))).status).toBe(503);
  });
  it('pins bootstrap owner, public PKCE client, API audience and invitation-only policy', () => {
    expect(INITIAL_SYSTEM_ADMIN_EMAIL).toBe('yanli.lam@stradaverse.ai');
    const realm = realmDefinition('https://hr.test');
    expect(realm.registrationAllowed).toBe(false); expect(realm.bruteForceProtected).toBe(true);
    const mobile = realm.clients.find(c => c.clientId === 'aihr-mobile')!;
    expect(mobile.publicClient).toBe(true); expect(mobile.directAccessGrantsEnabled).toBe(false);
    expect(mobile.attributes?.['pkce.code.challenge.method']).toBe('S256');
    expect(mobile.protocolMappers?.[0].config['id.token.claim']).toBe('false');
    expect(JSON.stringify(realm)).not.toContain('client_secret');
  });
});
