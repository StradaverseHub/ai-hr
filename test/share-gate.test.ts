/**
 * The SHARE_PASSWORD gate (middleware.ts), and readiness 1.4: it must fail CLOSED.
 *
 * WHAT WAS WRONG. `if (!password) return withPathname(req)` served the entire application when the
 * variable was absent — no error, no log, 200 on every route. The old version of this file asserted
 * that behaviour as correct ("is a no-op when SHARE_PASSWORD is unset"), which is why the hole survived
 * a green suite: the test was pinning the defect.
 *
 * TWO ARMS, AND THE SECOND IS THE ONE THAT ROTS. Refusing in production is easy to assert. What has to
 * survive alongside it is that `next dev` with no SHARE_PASSWORD still serves — and a test for that is
 * vacuous unless it (a) names NODE_ENV explicitly instead of inheriting vitest's 'test', and (b) asserts
 * a real PASS-THROUGH rather than `.not.toBe(401)`, which a 503, a 500 and a redirect all satisfy.
 *
 * So the pass-through assertions read what NextResponse.next({ request: { headers } }) actually emits:
 *   x-middleware-next: 1                  — Next is told to continue to the route
 *   x-middleware-override-headers         — which request headers were rewritten
 *   x-middleware-request-x-pathname: <p>  — the pathname the root layout reads to detect an auth route
 * A refusal carries none of them. That is the difference the second arm has to be able to see.
 *
 * NODE_ENV is stubbed per test (vi.stubEnv) because vitest runs at NODE_ENV=test, which under the
 * fail-closed predicate is a REFUSING environment — so a test that forgets to name it fails loudly
 * instead of passing for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { middleware as gateMiddleware } from '../middleware';

/** r390 — middleware() returns a Promise only with real WorkOS sign-in configured (test/r390-workos-middleware.test.ts).
 *  Every configuration in this file is the gate alone, which must stay synchronous; this pins that too. */
function middleware(r: NextRequest): NextResponse {
  const res = gateMiddleware(r);
  if (res instanceof Promise) throw new Error('without real sign-in the gate must answer synchronously');
  return res;
}

const req = (auth?: string, path = '/people') =>
  new NextRequest(`http://localhost${path}`, auth ? { headers: { authorization: auth } } : undefined);
const basic = (pass: string) => 'Basic ' + Buffer.from(`demo:${pass}`).toString('base64');

/** Every marker Next puts on a "continue to the route" response, so a refusal cannot satisfy this. */
const expectPassedThrough = (res: NextResponse, pathname: string) => {
  expect(res.status, 'a pass-through is 200').toBe(200);
  expect(res.headers.get('x-middleware-next'), 'Next is told to continue to the route').toBe('1');
  expect(res.headers.get('x-middleware-override-headers'), 'request headers were rewritten').toContain(
    'x-pathname',
  );
  expect(
    res.headers.get('x-middleware-request-x-pathname'),
    'the layout gets the pathname it needs to detect an auth route',
  ).toBe(pathname);
  expect(res.headers.get('www-authenticate'), 'not a Basic challenge either').toBeNull();
};

describe('share gate (middleware.ts)', () => {
  // Each test controls SHARE_PASSWORD explicitly — don't inherit it from the ambient env (.env.local,
  // which a hosting setup may populate and vitest loads).
  beforeEach(() => {
    delete process.env.SHARE_PASSWORD;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.SHARE_PASSWORD;
  });

  describe('configured (SHARE_PASSWORD set) — the gate behaves exactly as it always did', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.SHARE_PASSWORD = 'sekret';
    });

    it('challenges with 401 when gated and no credentials', () => {
      const res = middleware(req());
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
    });

    it('rejects a wrong password', () => {
      expect(middleware(req(basic('nope'))).status).toBe(401);
    });

    it('lets the correct password through (any username)', () => {
      expectPassedThrough(middleware(req(basic('sekret'))), '/people');
    });

    it('lets the WorkOS login flow past the challenge (ADR-0072), with x-pathname set', () => {
      expectPassedThrough(middleware(req(undefined, '/login')), '/login');
    });
  });

  describe('1.4 ARM 1 — SHARE_PASSWORD unset outside development must NOT serve the app', () => {
    it('refuses with 503 in a production build, and does not pass the request through', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const res = middleware(req());
      expect(res.status, 'a production build with no gate refuses to serve').toBe(503);
      expect(res.headers.get('x-middleware-next'), 'the request never reaches the route').toBeNull();
      expect(res.headers.get('x-middleware-request-x-pathname')).toBeNull();
    });

    it('refuses the LOGIN route too — a missing password is a broken deployment, not a gate decision', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const res = middleware(req(undefined, '/login'));
      expect(res.status, 'the front door is not an exception when nothing is configured').toBe(503);
      expect(res.headers.get('x-middleware-next')).toBeNull();
    });

    it('refuses even with Basic credentials — there is no password to compare them against', () => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(middleware(req(basic('anything'))).status).toBe(503);
    });

    it('refuses when NODE_ENV is unset entirely (the unnamed environment fails CLOSED)', () => {
      vi.stubEnv('NODE_ENV', undefined);
      expect(middleware(req()).status).toBe(503);
    });

    it('refuses under NODE_ENV=test as well — only `development` is allowed to run ungated', () => {
      vi.stubEnv('NODE_ENV', 'test');
      expect(middleware(req()).status).toBe(503);
    });

    it('says what is wrong and where to fix it, rather than failing blank', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const res = middleware(req());
      expect(res.headers.get('content-type')).toContain('text/plain');
      // Read as text so this asserts what an operator actually sees on the box.
      return res.text().then((body) => {
        expect(body).toContain('SHARE_PASSWORD');
        expect(body).toContain('.env.production');
      });
    });
  });

  describe('1.4 ARM 2 — `next dev` keeps working with no SHARE_PASSWORD', () => {
    it('passes an ordinary route straight through, with x-pathname set for the layout', () => {
      vi.stubEnv('NODE_ENV', 'development');
      expectPassedThrough(middleware(req()), '/people');
    });

    it('passes the login flow through too (the dev redirect-loop guard from lib/auth-routes.ts)', () => {
      vi.stubEnv('NODE_ENV', 'development');
      expectPassedThrough(middleware(req(undefined, '/login')), '/login');
    });

    it('never challenges and never refuses in dev, whatever the request carries', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const res = middleware(req(basic('irrelevant')));
      expect(res.status).toBe(200);
      expect(res.status).not.toBe(503);
    });

    it('still never gates dev even when SHARE_PASSWORD IS set in .env.local for hosting', () => {
      vi.stubEnv('NODE_ENV', 'development');
      process.env.SHARE_PASSWORD = 'sekret';
      expectPassedThrough(middleware(req()), '/people');
    });
  });

  describe('ADR-0088 — the mobile API bypasses the CHALLENGE, never the refusal', () => {
    const token = 'Bearer aaa.bbb.ccc';

    it('lets a bearer-carrying request to /api/mobile/* through a live gate (Basic cannot share the header)', () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.SHARE_PASSWORD = 'sekret';
      expectPassedThrough(middleware(req(token, '/api/mobile/v1/me')), '/api/mobile/v1/me');
    });

    it('passes a credential-less request through too — the handler, not the gate, refuses it', () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.SHARE_PASSWORD = 'sekret';
      expectPassedThrough(middleware(req(undefined, '/api/mobile/v1/payslips')), '/api/mobile/v1/payslips');
    });

    it('still challenges a look-alike path and every other API route', () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.SHARE_PASSWORD = 'sekret';
      for (const path of ['/api/mobilex', '/api/mobile-v1/me', '/api/payroll/reprocess-job/x', '/people']) {
        const res = middleware(req(token, path));
        expect(res.status, path).toBe(401);
        expect(res.headers.get('www-authenticate'), path).toContain('Basic');
      }
    });

    it('is refused with 503 like everything else when SHARE_PASSWORD is unset outside development', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const res = middleware(req(token, '/api/mobile/v1/me'));
      expect(res.status).toBe(503);
      expect(res.headers.get('x-middleware-next')).toBeNull();
    });
  });
});
