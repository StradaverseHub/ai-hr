/** AuthKit itself runs here for anonymous sessions and PKCE; no WorkOS account or network required. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requestContext = vi.hoisted(() => ({
  headers: new Headers(),
  cookieWrites: [] as { name: string; value: string; options: Record<string, unknown> }[],
  acceptInvitation: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: async () => requestContext.headers,
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      requestContext.cookieWrites.push({ name, value, options });
    },
  }),
}));
vi.mock('next/navigation', async (original) => ({
  ...await original<typeof import('next/navigation')>(),
  redirect: (url: string) => { throw new Error(`TEST_REDIRECT:${url}`); },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/principals', () => ({ listPrincipals: vi.fn() }));
vi.mock('@/core/auth', () => ({
  acceptInvitation: requestContext.acceptInvitation,
  recordLoginBlocked: vi.fn(), recordLoginSucceeded: vi.fn(),
}));

const CALLBACK = 'https://hr.customer.com/callback';
function configured() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('ALLOW_DEMO_SESSION', undefined);
  vi.stubEnv('SHARE_PASSWORD', 'holding-gate');
  vi.stubEnv('WORKOS_API_KEY', 'sk_customer_fixture');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_customer_fixture');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'fixture-cookie-secret-with-more-than-32-characters');
  vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI', CALLBACK);
  vi.stubEnv('WORKOS_CLAIM_TOKEN', undefined);
}
let middleware: typeof import('../middleware').middleware;
let sdk: typeof import('@workos-inc/authkit-nextjs');
beforeAll(async () => {
  // AuthKit reads env at module initialization, just as the deployed process does.
  configured();
  sdk = await import('@workos-inc/authkit-nextjs');
  ({ middleware } = await import('../middleware'));
});
beforeEach(() => {
  configured();
  requestContext.headers = new Headers();
  requestContext.cookieWrites = [];
  requestContext.acceptInvitation.mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network request in local auth test'); });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllEnvs(); });

function request(pathname = '/people', headers: Record<string, string> = {}, withGate = true) {
  return new NextRequest(`https://hr.customer.com${pathname}`, { headers: {
    ...(withGate ? { authorization: `Basic ${Buffer.from('tester:holding-gate').toString('base64')}` } : {}),
    ...headers,
  } });
}
function forwarded(response: Response) {
  const result = new Headers();
  for (const name of (response.headers.get('x-middleware-override-headers') ?? '').split(',')) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (name && value !== null) result.set(name, value);
  }
  return result;
}

describe('real authentication is connected to the AuthKit session carrier', () => {
  it('supplies the actual SDK withAuth prerequisite for an anonymous browser request', async () => {
    const response = await middleware(request());
    expect(response.headers.get('x-middleware-next')).toBe('1');
    requestContext.headers = forwarded(response);
    expect(requestContext.headers.get('x-pathname')).toBe('/people');
    expect(requestContext.headers.get('x-workos-middleware')).toBe('true');
    await expect(sdk.withAuth()).resolves.toEqual({ user: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // Ordinary anonymous page requests must not accumulate flow-specific PKCE cookies.
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('removing that carrier reproduces the original real-login failure', async () => {
    const response = await middleware(request());
    requestContext.headers = forwarded(response);
    requestContext.headers.delete('x-workos-middleware');
    await expect(sdk.withAuth()).rejects.toThrow("isn't covered by the AuthKit middleware");
  });
  it.each(['/login', '/login/workos', '/callback?code=fixture', '/invite/token/activate', '/reset-password'])('prepares %s without a Basic-auth challenge', async (pathname) => {
    const response = await middleware(request(pathname, {}, false));
    const headers = forwarded(response);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(headers.get('x-pathname')).toBe(pathname.split('?')[0]);
    expect(headers.get('x-workos-middleware')).toBe('true');
    expect(headers.get('x-redirect-uri')).toBe(CALLBACK);
  });
  it('removes spoofed session, callback, URL and future WorkOS headers', async () => {
    const response = await middleware(request('/people', {
      'x-workos-session': 'attacker-session', 'x-workos-middleware': 'attacker-marker',
      'x-workos-future': 'attacker-future', 'x-redirect-uri': 'https://attacker.invalid/callback',
      'x-url': 'https://attacker.invalid/', 'x-sign-up-paths': '/people', 'x-pathname': '/login',
    }));
    const headers = forwarded(response);
    expect(headers.get('x-workos-session')).toBeNull();
    expect(headers.get('x-workos-future')).toBeNull();
    expect(headers.get('x-sign-up-paths')).toBeNull();
    expect(headers.get('x-workos-middleware')).toBe('true');
    expect(headers.get('x-redirect-uri')).toBe(CALLBACK);
    expect(headers.get('x-url')).toBe('https://hr.customer.com/people');
    expect(headers.get('x-pathname')).toBe('/people');
    requestContext.headers = headers;
    await expect(sdk.withAuth()).resolves.toEqual({ user: null });
    for (const key of ['x-workos-session', 'x-workos-middleware', 'x-url', 'x-redirect-uri']) {
      expect(response.headers.get(key)).toBeNull();
    }
  });
  it('forwards trusted refresh cookies and server session headers without exposing the session', async () => {
    vi.spyOn(sdk, 'authkit').mockResolvedValue({
      session: { user: null },
      headers: new Headers({
        'x-workos-middleware': 'true', 'x-workos-session': 'provider-verified-session',
        'set-cookie': 'wos-session=refreshed; HttpOnly; Secure; Path=/',
        'vary': 'Cookie', 'x-workos-future': 'never-send-to-browser',
      }),
    });
    const response = await middleware(request());
    expect(forwarded(response).get('x-workos-session')).toBe('provider-verified-session');
    expect(response.headers.get('x-workos-session')).toBeNull();
    expect(response.headers.get('x-workos-future')).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('wos-session=refreshed');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
  });
  it('does not consume the body of an authenticated server-action POST', async () => {
    const req = new NextRequest('https://hr.customer.com/people', {
      method: 'POST', body: 'employee=fixture', headers: request().headers,
    });
    const response = await middleware(req);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(req.bodyUsed).toBe(false);
    await expect(req.text()).resolves.toBe('employee=fixture');
  });
  it('keeps the holding gate ahead of provider work', async () => {
    const auth = vi.spyOn(sdk, 'authkit');
    expect((await middleware(request('/people', {}, false))).status).toBe(401);
    vi.stubEnv('SHARE_PASSWORD', undefined);
    expect((await middleware(request('/login', {}, false))).status).toBe(503);
    expect(auth).not.toHaveBeenCalled();
  });
  it.each(['/health', '/api/mobile/v1/me'])('leaves %s on its independent authentication path', async (pathname) => {
    const auth = vi.spyOn(sdk, 'authkit');
    const response = await middleware(request(pathname, { 'x-workos-session': 'forged' }, false));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(forwarded(response).get('x-workos-session')).toBeNull();
    expect(auth).not.toHaveBeenCalled();
  });
  it('preserves demo and development identity switching without WorkOS calls', async () => {
    const auth = vi.spyOn(sdk, 'authkit');
    vi.stubEnv('ALLOW_DEMO_SESSION', 'true');
    expect((await middleware(request())).headers.get('x-middleware-next')).toBe('1');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_DEMO_SESSION', undefined);
    vi.stubEnv('SHARE_PASSWORD', undefined);
    expect((await middleware(request('/people', {}, false))).headers.get('x-middleware-next')).toBe('1');
    expect(auth).not.toHaveBeenCalled();
  });
});

describe('sign-in handoff writes PKCE only in the route handler', () => {
  it('the real SDK creates a secure, HttpOnly PKCE cookie matching the authorization state', async () => {
    const { GET } = await import('../app/login/workos/route');
    requestContext.headers = forwarded(await middleware(request('/login/workos', {}, false)));
    const response = await GET(request('/login/workos', {}, false));
    const location = new URL(response.headers.get('location')!);
    expect(location.protocol).toBe('https:');
    expect(location.hostname).toBe('api.workos.com');
    expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(requestContext.cookieWrites).toHaveLength(1);
    const cookie = requestContext.cookieWrites[0]!;
    expect(cookie.name).toMatch(/^wos-auth-verifier-/);
    expect(cookie.value).toBe(location.searchParams.get('state'));
    expect(cookie.options).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', maxAge: 600 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.invalid/', '//attacker.invalid', '/\\attacker.invalid', '/login', '/people', '/invite/../activate', '/invite/x/activate?next=evil'])('refuses unowned return path %s without minting a cookie', async (returnTo) => {
    const { GET } = await import('../app/login/workos/route');
    const response = await GET(request(`/login/workos?returnTo=${encodeURIComponent(returnTo)}`, {}, false));
    expect(response.status).toBe(400);
    expect(requestContext.cookieWrites).toHaveLength(0);
  });
  it('accepts an invitation activation return path and preserves it through the provider seam', async () => {
    const provider = await import('../lib/workos');
    const signIn = vi.spyOn(provider, 'signInUrl').mockResolvedValue('https://api.workos.com/user_management/authorize');
    const { GET } = await import('../app/login/workos/route');
    const response = await GET(request('/login/workos?returnTo=%2Finvite%2Fabc_123-xyz%2Factivate', {}, false));
    expect(response.status).toBe(307);
    expect(signIn).toHaveBeenCalledWith('/invite/abc_123-xyz/activate');
  });
  it('login page redirects to the cookie-capable handler without writing during rendering', async () => {
    const { default: LoginPage } = await import('../app/login/page');
    await expect(LoginPage()).rejects.toThrow('TEST_REDIRECT:/login/workos');
    expect(requestContext.cookieWrites).toHaveLength(0);
  });
  it('invitation page redirects through the handler with its token and without consuming the invite', async () => {
    const { default: InviteActivatePage } = await import('../app/invite/[token]/activate/page');
    requestContext.headers = forwarded(await middleware(request('/invite/abc_123/activate', {}, false)));
    await expect(InviteActivatePage({ params: Promise.resolve({ token: 'abc_123' }) }))
      .rejects.toThrow('TEST_REDIRECT:/login/workos?returnTo=%2Finvite%2Fabc_123%2Factivate');
    expect(requestContext.cookieWrites).toHaveLength(0);
    expect(requestContext.acceptInvitation).not.toHaveBeenCalled();
  });
  it('does not enable provider sign-in on the consultant demo', async () => {
    vi.stubEnv('ALLOW_DEMO_SESSION', 'true');
    const { GET } = await import('../app/login/workos/route');
    const response = await GET(request('/login/workos', {}, false));
    expect(response.headers.get('location')).toBe('https://hr.customer.com/login');
    expect(requestContext.cookieWrites).toHaveLength(0);
  });
  it('the callback refuses mismatched OAuth state before any provider exchange', async () => {
    const { GET } = await import('../app/callback/route');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET(request('/callback?code=fixture&state=state-a', { cookie: 'wos-auth-verifier=state-b' }, false));
    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
