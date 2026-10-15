import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const service = vi.hoisted(() => ({ startLogin: vi.fn(), changeInitialPassword: vi.fn(), verifyMfa: vi.fn(), rotateRefresh: vi.fn(), revokeSession: vi.fn() }));
const recovery = vi.hoisted(() => ({ requestRecovery: vi.fn(), completeRecovery: vi.fn() }));
const postResponse = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: postResponse.after }));
vi.mock('../lib/internal-auth/service', () => ({ ...service, InternalAuthError: class extends Error { constructor(public code: string) { super(code); } } }));
vi.mock('../lib/internal-auth/recovery', () => recovery);
vi.mock('../lib/internal-auth/invitations', () => ({ startInvitation: vi.fn(), acceptInternalInvitation: vi.fn() }));
import { POST } from '../app/login/api/[operation]/route';
const access = 'aihr_' + 'a'.repeat(43), refresh = 'aihr_refresh_' + 'b'.repeat(43);
function request(operation: string, body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest(`https://hr.test/login/api/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ operation }) });
}
beforeEach(() => { vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', 'a'.repeat(64)); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
describe('embedded auth HTTP trust and credential carriers', () => {
  it('refuses missing or foreign browser Origin before attempting a password check', async () => {
    const variants: Record<string, string>[] = [{}, { origin: 'https://other.test' }, { origin: 'null' }, { origin: 'https://other.test', 'x-aihr-client': 'native' }];
    for (const headers of variants) {
      expect((await request('login', { username: 'user', password: 'secret' }, headers)).status).toBe(403);
    }
    expect(service.startLogin).not.toHaveBeenCalled();
  });
  it('keeps browser handles out of JSON and sets only the secure host cookie', async () => {
    const browserHandle = 'w'.repeat(43);
    service.startLogin.mockResolvedValue({ step: 'complete', access_token: browserHandle, expires_in: 28800 });
    const response = await request('login', { organization: 'alpha', username: 'user', password: 'secret' }, { origin: 'https://hr.test' });
    expect(await response.json()).toEqual({ step: 'complete' });
    const cookie = response.headers.get('set-cookie')!;
    expect(response.cookies.get('__Host-aihr_internal')?.value).toBe(browserHandle);
    for (const piece of ['__Host-aihr_internal=', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=lax']) expect(cookie).toContain(piece);
    expect(cookie).not.toContain('Domain='); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(service.startLogin).toHaveBeenCalledWith(expect.objectContaining({ native: false }));
  });
  it('does not issue a browser session cookie while password change or MFA is still pending', async () => {
    for (const step of ['password', 'mfa']) {
      service.startLogin.mockResolvedValue({ step, challenge: 'c'.repeat(43) });
      const response = await request('login', { organization: 'alpha', username: 'user', password: 'secret' }, { origin: 'https://hr.test' });
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.json()).toEqual({ step, challenge: 'c'.repeat(43) });
    }
  });
  it('native login returns opaque handles without setting a browser cookie', async () => {
    service.startLogin.mockResolvedValue({ step: 'complete', access_token: access, refresh_token: refresh, expires_in: 900 });
    const response = await request('login', { organization: 'alpha', username: 'user', password: 'secret' }, { 'x-aihr-client': 'native', cookie: '__Host-aihr_internal=forged' });
    expect((await response.json()).access_token).toBe(access); expect(response.headers.get('set-cookie')).toBeNull();
    expect(service.startLogin).toHaveBeenCalledWith(expect.objectContaining({ native: true }));
  });
  it('native logout ignores any browser cookie and revokes only its explicit native credential', async () => {
    const response = await request('logout', { refresh_token: refresh }, { 'x-aihr-client': 'native', cookie: '__Host-aihr_internal=browser-value' });
    expect(response.status).toBe(200); expect(service.revokeSession).toHaveBeenCalledWith(undefined, true, refresh);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('rejects malformed JSON, non-object values, oversized bodies and form posts without calling auth', async () => {
    for (const [body, headers] of [ ['{', {}], [[], {}], ['x'.repeat(8200), {}], ['username=user', { 'content-type': 'application/x-www-form-urlencoded' }] ] as const) {
      const response = await request('login', body, { origin: 'https://hr.test', ...headers });
      expect(response.status).toBe(400);
    }
    expect(service.startLogin).not.toHaveBeenCalled();
  });
  it('refuses inactive or incomplete internal configuration without falling back to demo', async () => {
    vi.stubEnv('ALLOW_DEMO_SESSION', 'true'); vi.stubEnv('AUTH_SESSION_KEY', 'broken');
    expect((await request('login', {}, { origin: 'https://hr.test' })).status).toBe(503);
    vi.stubEnv('AUTH_PROVIDER', 'keycloak'); expect((await request('login', {}, { origin: 'https://hr.test' })).status).toBe(404);
    expect(service.startLogin).not.toHaveBeenCalled();
  });
  it('schedules the single recovery delivery after the same public confirmation, without awaiting SMTP', async () => {
    const delivery = vi.fn(async () => { throw new Error('This slow relay must not run before the response.'); });
    recovery.requestRecovery.mockImplementation(async (_organization, _username, _transport, dispatch) => { dispatch(delivery); });
    const response = await request('recovery', { organization: 'alpha', username: 'user' }, { origin: 'https://hr.test' });
    expect(response.status).toBe(200);expect(await response.json()).toEqual({step:'sent'});
    expect(postResponse.after).toHaveBeenCalledWith(delivery);expect(delivery).not.toHaveBeenCalled();
    recovery.requestRecovery.mockImplementation(async () => {});
    const unknown = await request('recovery', { organization: 'alpha', username: 'unknown' }, { origin: 'https://hr.test' });
    expect(unknown.status).toBe(200);expect(await unknown.json()).toEqual({step:'sent'});
  });
});
