import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const service = vi.hoisted(() => ({ startLogin: vi.fn(), changeInitialPassword: vi.fn(), verifyMfa: vi.fn(), rotateRefresh: vi.fn(), revokeSession: vi.fn() }));
const intl=vi.hoisted(()=>({getLocale:vi.fn(async()=> 'en')}));
vi.mock('next-intl/server',()=>({getLocale:intl.getLocale}));
const recovery = vi.hoisted(() => ({ requestRecovery: vi.fn(), completeRecovery: vi.fn() }));
const postResponse = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: postResponse.after }));
vi.mock('../lib/internal-auth/service', () => ({ ...service, InternalAuthError: class extends Error { constructor(public code: string) { super(code); } } }));
vi.mock('../lib/internal-auth/recovery', () => recovery);
const invitations = vi.hoisted(() => ({ startInvitation: vi.fn(), acceptInternalInvitation: vi.fn() }));
const identity = vi.hoisted(() => ({ currentInternalIdentity: vi.fn() }));
vi.mock('../lib/internal-auth/invitations', () => invitations);
vi.mock('../lib/internal-auth/web-session', () => identity);
import { POST } from '../app/(auth)/login/api/[operation]/route';
const access = 'aihr_' + 'a'.repeat(43), refresh = 'aihr_refresh_' + 'b'.repeat(43);
function request(operation: string, body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest(`https://hr.test/login/api/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ operation }) });
}
beforeEach(() => { vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', 'a'.repeat(64)); vi.clearAllMocks();intl.getLocale.mockResolvedValue('en'); });
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
  it('renders authenticator enrollment as a local PNG while keeping it a partial challenge', async () => {
    service.startLogin.mockResolvedValue({step:'enroll',challenge:'c'.repeat(43),secret:'A'.repeat(32),account:'alpha:owner'});
    const response=await request('login',{organization:'alpha',username:'owner',password:'secret'},{origin:'https://hr.test'});
    expect(response.status).toBe(200);
    const reply=await response.json();expect(reply).toMatchObject({step:'enroll',challenge:'c'.repeat(43),secret:'A'.repeat(32)});
    expect(reply.qr).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(reply.qr.split(',')[1],'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(response.headers.get('set-cookie')).toBeNull();expect(reply).not.toHaveProperty('access_token');
  });
  it('returns the verified activation organization and clears an old browser session instead of signing in', async () => {
    service.verifyMfa.mockResolvedValue({ step: 'activated', organization: 'new-customer', recoveryCodes: ['BACKUP-CODE'] });
    const response = await request('mfa', { challenge: 'c'.repeat(43), code: '123456', organization: 'forged' },
      { origin: 'https://hr.test', cookie: '__Host-aihr_internal=old-browser-session' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ step: 'activated', organization: 'new-customer', recoveryCodes: ['BACKUP-CODE'] });
    expect(service.revokeSession).toHaveBeenCalledWith('old-browser-session');
    expect(response.cookies.get('__Host-aihr_internal')?.value).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(service.verifyMfa).toHaveBeenCalledWith('c'.repeat(43), '123456', false);
  });
  it('also sends an already authenticated invitee to their organization login after acceptance', async () => {
    const verified = { issuer: 'https://hr.test/auth/tenant', subject: 'existing', email: 'existing@example.test', emailVerified: true };
    identity.currentInternalIdentity.mockResolvedValue(verified);
    invitations.acceptInternalInvitation.mockResolvedValue('existing-customer');
    const response = await request('accept-invite', { token: 'i'.repeat(43), organization: 'forged' },
      { origin: 'https://hr.test', cookie: '__Host-aihr_internal=existing-browser-session' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ step: 'activated', organization: 'existing-customer' });
    expect(invitations.acceptInternalInvitation).toHaveBeenCalledWith('i'.repeat(43), verified);
    expect(service.revokeSession).toHaveBeenCalledWith('existing-browser-session');
    expect(response.cookies.get('__Host-aihr_internal')?.value).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
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
    expect(recovery.requestRecovery).toHaveBeenNthCalledWith(1,'alpha','user',undefined,expect.any(Function),false,'en');
    recovery.requestRecovery.mockImplementation(async () => {});
    const unknown = await request('recovery', { organization: 'alpha', username: 'unknown' }, { origin: 'https://hr.test' });
    expect(unknown.status).toBe(200);expect(await unknown.json()).toEqual({step:'sent'});
  });
  it('passes explicit recovery language independently from server-owned source admission',async()=>{
    recovery.requestRecovery.mockResolvedValue(undefined);
    const response=await request('recovery',{organization:'alpha',username:'user',locale:'ms'},{origin:'https://hr.test'});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({step:'sent'});
    expect(recovery.requestRecovery).toHaveBeenCalledWith('alpha','user',undefined,expect.any(Function),false,'ms');expect(intl.getLocale).not.toHaveBeenCalled();
  });
});
