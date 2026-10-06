/**
 * r390 — REAL WORKOS SIGN-IN THROUGH middleware.ts, WITH THE REAL AUTHKIT SDK.
 *
 * Every earlier auth test mocked lib/workos, which is how two blockers stayed invisible: authkit-nextjs
 * 4.2.0's withAuth() THROWS unless its middleware ran on the request, and getSignInUrl() sets a cookie a
 * Server Component may not set. This file runs the real SDK for every signed-out case (no network is
 * needed: a request without a session cookie never verifies or refreshes a token). The signed-in cases need
 * a token WorkOS would accept, so they replace only `authkit()` and keep the SDK's own header helpers.
 *
 * Settings are fixture values invented for the test, not credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';

const ORIGIN = 'https://aihr.example.test';
const REAL_AUTH = {
  NODE_ENV: 'production',
  WORKOS_API_KEY: 'sk_test_r390_fixture',
  WORKOS_CLIENT_ID: 'client_r390_fixture',
  WORKOS_COOKIE_PASSWORD: 'r390-fixture-cookie-password-at-least-32-characters',
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${ORIGIN}/callback`,
};

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ['NODE_ENV', 'ALLOW_DEMO_SESSION', 'SHARE_PASSWORD', ...Object.keys(REAL_AUTH)]) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) if (v !== undefined) vi.stubEnv(k, v);
}

/** The SDK reads its settings at import, so every case re-imports middleware.ts after setting them. */
async function loadMiddleware() {
  vi.resetModules();
  return (await import('../middleware')).middleware;
}

// Behind the Cloudflare tunnel the app sees the LOCAL address; the browser is on the public origin.
const req = (path: string, init?: { method?: string; headers?: Record<string, string> }) =>
  new NextRequest(`http://127.0.0.1:3000${path}`, { method: init?.method ?? 'GET', headers: { accept: 'text/html', ...init?.headers } });

const passedThrough = (res: NextResponse) => res.headers.get('x-middleware-next') === '1';
const forwarded = (res: NextResponse, name: string) => res.headers.get(`x-middleware-request-${name}`);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@workos-inc/authkit-nextjs');
  vi.resetModules();
});

describe('real sign-in on, signed out (real SDK)', () => {
  beforeEach(() => setEnv(REAL_AUTH));

  it.each(['/', '/leave', '/login'])('a page (%s) redirects to AuthKit with our client and PUBLIC callback, and sets the PKCE cookie', async (path) => {
    const res = await (await loadMiddleware())(req(path));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://api.workos.com');
    expect(location.searchParams.get('client_id')).toBe(REAL_AUTH.WORKOS_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    // The verifier the callback will need, set on THIS response (a Server Component could not), Secure.
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/wos-auth-verifier-[^=]+=/);
    expect(cookie.toLowerCase()).toContain('secure');
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('an API route answers 401 instead of a redirect a fetch cannot follow', async () => {
    const res = await (await loadMiddleware())(req('/api/leave/export'));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });

  it('a server action answers 401 too', async () => {
    const res = await (await loadMiddleware())(req('/leave', { method: 'POST', headers: { 'next-action': 'abc123' } }));
    expect(res.status).toBe(401);
  });

  it.each(['/callback', '/invite/token123', '/reset-password'])('%s stays reachable signed out, with x-pathname and the AuthKit marker forwarded', async (path) => {
    const res = await (await loadMiddleware())(req(path));
    expect(passedThrough(res)).toBe(true);
    expect(forwarded(res, 'x-pathname')).toBe(path);
    expect(forwarded(res, 'x-workos-middleware')).toBe('true'); // what withAuth() requires
  });

  it.each(['/health', '/api/mobile/v1/me'])('%s bypasses AuthKit (health check; bearer-token API)', async (path) => {
    const res = await (await loadMiddleware())(req(path));
    expect(passedThrough(res)).toBe(true);
    expect(forwarded(res, 'x-workos-middleware')).toBeNull();
  });

  it('no internal AuthKit header ever reaches the browser', async () => {
    const res = await (await loadMiddleware())(req('/'));
    for (const name of res.headers.keys()) expect(name.startsWith('x-workos-')).toBe(false);
  });

  it('a demo password kept during the changeover is an OUTER layer: Basic first, then AuthKit', async () => {
    setEnv({ ...REAL_AUTH, SHARE_PASSWORD: 'changeover-pass' });
    const mw = await loadMiddleware();
    expect((await mw(req('/'))).status).toBe(401); // Basic challenge
    const ok = await mw(req('/', { headers: { authorization: `Basic ${btoa('x:changeover-pass')}` } }));
    expect(ok.status).toBe(307);
    expect(new URL(ok.headers.get('location')!).origin).toBe('https://api.workos.com');
  });
});

describe('what is NOT real sign-in', () => {
  it('the demo switcher (ALLOW_DEMO_SESSION=true) keeps today’s behaviour even with WorkOS configured', async () => {
    setEnv({ ...REAL_AUTH, ALLOW_DEMO_SESSION: 'true', SHARE_PASSWORD: 'demo-pass' });
    const mw = await loadMiddleware();
    expect((await mw(req('/'))).status).toBe(401);
    const ok = await mw(req('/', { headers: { authorization: `Basic ${btoa('x:demo-pass')}` } }));
    expect(passedThrough(ok)).toBe(true);
    expect(forwarded(ok, 'x-workos-middleware')).toBeNull();
  });

  it.each(['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_COOKIE_PASSWORD', 'NEXT_PUBLIC_WORKOS_REDIRECT_URI'])(
    'half a configuration (no %s) and no password still refuses with 503 — never open',
    async (missing) => {
      setEnv({ ...REAL_AUTH, [missing]: undefined });
      const res = await (await loadMiddleware())(req('/'));
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('WORKOS_COOKIE_PASSWORD');
    },
  );
});

describe('real sign-in on, signed in (authkit() replaced; the SDK header helpers are real)', () => {
  async function loadSignedIn(user: { id: string; email: string } | null) {
    vi.resetModules();
    vi.doMock('@workos-inc/authkit-nextjs', async (importOriginal) => {
      const real = await importOriginal<typeof import('@workos-inc/authkit-nextjs')>();
      return {
        ...real,
        authkit: vi.fn(async () => ({
          session: { user },
          headers: new Headers({ 'x-workos-middleware': 'true', 'x-workos-session': 'sealed-session-fixture', 'x-url': 'http://127.0.0.1:3000/' }),
          authorizationUrl: 'https://api.workos.com/user_management/authorize?client_id=client_r390_fixture',
        })),
      };
    });
    return (await import('../middleware')).middleware;
  }

  beforeEach(() => setEnv(REAL_AUTH));

  it('a page passes through with the session headers withAuth() reads, plus x-pathname', async () => {
    const res = await (await loadSignedIn({ id: 'user_r390', email: 'irwin@example.test' }))(req('/leave'));
    expect(passedThrough(res)).toBe(true);
    expect(forwarded(res, 'x-workos-middleware')).toBe('true');
    expect(forwarded(res, 'x-workos-session')).toBe('sealed-session-fixture');
    expect(forwarded(res, 'x-pathname')).toBe('/leave');
  });

  it('/login when already signed in goes HOME on the public origin, not to 127.0.0.1', async () => {
    const res = await (await loadSignedIn({ id: 'user_r390', email: 'irwin@example.test' }))(req('/login'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });
});
