/**
 * Recruitment slice 8, case 56: the public careers paths are admitted signed out under EVERY authentication provider
 * branch of middleware.ts (internal, Keycloak, legacy WorkOS with the real SDK, and the demo Basic gate), set no cookie,
 * and every neighbouring path — including other /careers shapes and Recruitment's HR pages — still requires sign-in.
 * The careers handlers are exercised with the pack service replaced, so this file needs no database. Fixture settings
 * are invented for the test, not credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const service = vi.hoisted(() => ({ careersPublicPage: vi.fn(), careersPublicJob: vi.fn(), submitCareersApplication: vi.fn(), careersClientLimited: vi.fn() }));
vi.mock('@/packs/recruitment/service', async (importOriginal) => ({ ...(await importOriginal<object>()), ...service }));

const origin = 'https://hr.example.test';
const JOB = '0b4f5c0e-8a0c-4d3c-9a43-1f2e3d4c5b6a';
const internal = { AUTH_PROVIDER: 'internal', AUTH_PUBLIC_ORIGIN: origin, AUTH_SESSION_KEY: 'a'.repeat(64) };
const keycloak = {
  ...internal, AUTH_PROVIDER: 'keycloak', KEYCLOAK_ISSUER: `${origin}/identity/realms/ai-hr`, KEYCLOAK_WEB_CLIENT_ID: 'fixture-web',
  KEYCLOAK_WEB_CLIENT_SECRET: 'fixture-secret', KEYCLOAK_MOBILE_CLIENT_ID: 'fixture-mobile', KEYCLOAK_API_AUDIENCE: 'fixture-api',
};
const workos = {
  AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test_fixture', WORKOS_CLIENT_ID: 'client_fixture',
  WORKOS_COOKIE_PASSWORD: 'fixture-cookie-password-at-least-32-characters', NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${origin}/callback`,
};
const demo = { SHARE_PASSWORD: 'fixture-demo-password' };
function environment(values: Record<string, string>) {
  for (const key of ['AUTH_PROVIDER', 'AUTH_PUBLIC_ORIGIN', 'AUTH_SESSION_KEY', 'SHARE_PASSWORD', 'ALLOW_DEMO_SESSION', 'AIHR_TRUST_REQUEST_SOURCE', ...Object.keys(keycloak), ...Object.keys(workos)]) {
    vi.stubEnv(key, '');
  }
  vi.stubEnv('NODE_ENV', 'production');
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}
async function gate(path: string, method = 'GET', headers: Record<string, string> = {}) {
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(origin + path, { method, headers: { accept: 'text/html', ...headers } }));
}
const passed = (r: Response) => r.headers.get('x-middleware-next') === '1';

beforeEach(() => {
  vi.resetModules();
  for (const f of Object.values(service)) f.mockReset();
  service.careersClientLimited.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

const BRANCHES = [['internal', internal], ['keycloak', keycloak], ['workos', workos], ['demo', demo]] as const;

describe('case 56 — the careers paths are public under every provider branch; nothing else is', () => {
  it.each(BRANCHES)('%s: admits the page and job (GET/HEAD, and POST to the job) signed out, with no cookie, redirect or challenge', async (_name, settings) => {
    environment(settings);
    for (const [path, method] of [['/careers/fictional-co', 'GET'], ['/careers/fictional-co', 'HEAD'], [`/careers/fictional-co/jobs/${JOB}`, 'GET'],
      [`/careers/fictional-co/jobs/${JOB}`, 'HEAD'], [`/careers/fictional-co/jobs/${JOB}`, 'POST']] as const) {
      const r = await gate(path, method);
      expect(passed(r), `${method} ${path}`).toBe(true);
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie'), `${method} ${path}`).toBeNull();
      expect(r.headers.get('location')).toBeNull();
      expect(r.headers.get('www-authenticate')).toBeNull();
      // The path reaches the handler as is; no identity header is forwarded for a visitor.
      expect(r.headers.get('x-middleware-request-x-pathname')).toBe(path);
    }
    // A stale or forged session cookie changes nothing and is not rewritten.
    const withCookie = await gate('/careers/fictional-co', 'GET', { cookie: 'aihr_session=forged; wos-session=forged' });
    expect(passed(withCookie)).toBe(true);
    expect(withCookie.headers.get('set-cookie')).toBeNull();
  });

  it.each(BRANCHES)('%s: every neighbouring shape and the HR pages still require sign-in', async (_name, settings) => {
    environment(settings);
    const neighbours: [string, string][] = [
      ['/careers', 'GET'], ['/careers/', 'GET'], ['/careers/fictional-co/', 'GET'], ['/careers/fictional-co/jobs', 'GET'], [`/careers/fictional-co/jobs/${JOB}/apply`, 'GET'],
      ['/careers/fictional-co/admin', 'GET'], ['/careers/Fictional-Co', 'GET'], ['/careers/fictional-co%2Fadmin', 'GET'], [`/careers/fictional-co/jobs/${JOB.toUpperCase()}`, 'GET'],
      ['/careers/fictional-co', 'POST'], [`/careers/fictional-co/jobs/${JOB}`, 'PUT'], [`/careers/fictional-co/jobs/${JOB}`, 'DELETE'],
      ['/recruitment', 'GET'], ['/recruitment/settings', 'GET'], [`/recruitment/positions/${JOB}`, 'GET'], ['/careersx/fictional-co', 'GET'],
    ];
    for (const [path, method] of neighbours) {
      const r = await gate(path, method);
      expect(passed(r), `${method} ${path}`).toBe(false);
      expect([302, 303, 307, 401], `${method} ${path}`).toContain(r.status);
    }
  });

  it.each([['internal missing key', { ...internal, AUTH_SESSION_KEY: '' }], ['keycloak missing secret', { ...keycloak, KEYCLOAK_WEB_CLIENT_SECRET: '' }],
    ['unknown provider', { AUTH_PROVIDER: 'unknown' }], ['unconfigured', {}]] as const)('keeps fail-closed readiness for %s', async (_name, settings) => {
    environment(settings);
    const r = await gate('/careers/fictional-co');
    expect(r.status).toBe(503);
    expect(passed(r)).toBe(false);
  });
});

describe('the careers handlers answer with the strict policy and set no cookie', () => {
  it('returns the same Not found, with the security headers, for a page or job that is not public', async () => {
    environment({ ...internal, AIHR_TRUST_REQUEST_SOURCE: '1' });
    service.careersPublicPage.mockResolvedValue(null);
    service.careersPublicJob.mockResolvedValue(null);
    const { GET: page } = await import('../app/careers/[address]/route');
    const { GET: job, POST: apply } = await import('../app/careers/[address]/jobs/[jobId]/route');
    const responses = [
      await page(new NextRequest(`${origin}/careers/fictional-co`), { params: Promise.resolve({ address: 'fictional-co' }) }),
      await page(new NextRequest(`${origin}/careers/BAD`), { params: Promise.resolve({ address: 'BAD' }) }),
      await job(new NextRequest(`${origin}/careers/fictional-co/jobs/${JOB}`), { params: Promise.resolve({ address: 'fictional-co', jobId: JOB }) }),
      await apply(new NextRequest(`${origin}/careers/fictional-co/jobs/${JOB}`, { method: 'POST', body: new FormData(), headers: { 'x-aihr-request-source': '192.0.2.10' } }),
        { params: Promise.resolve({ address: 'fictional-co', jobId: JOB }) }),
    ];
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(r.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/);
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('Page not found');
    // The job is checked before anything is submitted.
    expect(service.submitCareersApplication).not.toHaveBeenCalled();
  });

  it('never shows a database diagnostic: a failing read is a plain "temporarily unavailable"', async () => {
    environment(internal);
    service.careersPublicPage.mockRejectedValue(Object.assign(new Error('SQL secret diagnostic Fictional Applicant'), { code: '57014' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { GET: page } = await import('../app/careers/[address]/route');
      const r = await page(new NextRequest(`${origin}/careers/fictional-co`), { params: Promise.resolve({ address: 'fictional-co' }) });
      expect(r.status).toBe(503);
      expect(await r.text()).not.toContain('SQL secret');
      expect(JSON.stringify(log.mock.calls)).not.toContain('SQL secret');
      expect(log.mock.calls).toEqual([['careers request failed', 'page', 'Error', '57014']]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('per-process admission bounds anonymous work', () => {
  const pending = () => {
    const waiters: ((v: null) => void)[] = [];
    return { promise: () => new Promise<null>((resolve) => { waiters.push(resolve); }), release: () => { for (const w of waiters.splice(0)) w(null); } };
  };
  it('turns reads beyond the cap away at once with a short busy page, and admits again once they finish', async () => {
    environment(internal);
    const { CAREERS_READ_ADMISSION } = await import('../app/careers/careers-http');
    const { GET: page } = await import('../app/careers/[address]/route');
    const hold = pending();
    service.careersPublicPage.mockImplementation(hold.promise);
    const call = () => page(new NextRequest(`${origin}/careers/fictional-co`), { params: Promise.resolve({ address: 'fictional-co' }) });
    const inFlight = Array.from({ length: CAREERS_READ_ADMISSION }, call);
    await vi.waitFor(() => expect(service.careersPublicPage).toHaveBeenCalledTimes(CAREERS_READ_ADMISSION));
    const busy = await call();
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await busy.text()).toContain('Busy right now');
    expect(service.careersPublicPage).toHaveBeenCalledTimes(CAREERS_READ_ADMISSION);
    hold.release();
    expect((await Promise.all(inFlight)).map((r) => r.status)).toEqual(inFlight.map(() => 404));
    service.careersPublicPage.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it('answers submissions beyond the cap with 429 before reading their bodies', async () => {
    environment({ ...internal, AIHR_TRUST_REQUEST_SOURCE: '1' });
    const { CAREERS_SUBMIT_ADMISSION } = await import('../app/careers/careers-http');
    const { POST: apply } = await import('../app/careers/[address]/jobs/[jobId]/route');
    const hold = pending();
    service.careersPublicJob.mockImplementation(hold.promise);
    const call = () => apply(new NextRequest(`${origin}/careers/fictional-co/jobs/${JOB}`, { method: 'POST', body: new FormData(), headers: { 'x-aihr-request-source': '192.0.2.10' } }),
      { params: Promise.resolve({ address: 'fictional-co', jobId: JOB }) });
    const inFlight = Array.from({ length: CAREERS_SUBMIT_ADMISSION }, call);
    await vi.waitFor(() => expect(service.careersPublicJob).toHaveBeenCalledTimes(CAREERS_SUBMIT_ADMISSION));
    const busy = await call();
    expect(busy.status).toBe(429);
    expect(await busy.text()).toContain('Busy right now');
    expect(service.careersPublicJob).toHaveBeenCalledTimes(CAREERS_SUBMIT_ADMISSION);
    hold.release();
    await Promise.all(inFlight);
    expect(service.submitCareersApplication).not.toHaveBeenCalled();
  });

  it('refuses a submission without a verified source before admission, parsing or any database call', async () => {
    environment(internal);
    const { POST: apply } = await import('../app/careers/[address]/jobs/[jobId]/route');
    const r = await apply(new NextRequest(`${origin}/careers/fictional-co/jobs/${JOB}`, { method: 'POST', body: new FormData(), headers: { 'x-aihr-request-source': '192.0.2.10' } }),
      { params: Promise.resolve({ address: 'fictional-co', jobId: JOB }) });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('Online applications are not available right now.');
    expect(service.careersPublicJob).not.toHaveBeenCalled();
    expect(service.submitCareersApplication).not.toHaveBeenCalled();
  });

  it('maps an unexpected failure during a submission to the unavailable page, never to a limit page', async () => {
    environment({ ...internal, AIHR_TRUST_REQUEST_SOURCE: '1' });
    service.careersPublicJob.mockResolvedValue({
      displayName: 'Fictional Co', notice: { version: 1, body: 'Fictional notice' },
      job: { id: JOB, title: 'Fictional job', jobNumber: 'MJ000001', employmentType: 'full_time', workLocation: 'Kuala Lumpur', postedAt: '2026-11-10T00:00:00.000Z', description: null },
    });
    service.submitCareersApplication.mockRejectedValue(new TypeError('unexpected'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { POST: apply } = await import('../app/careers/[address]/jobs/[jobId]/route');
      const f = new FormData();
      for (const [k, v] of Object.entries({ fullName: 'Fictional', email: 'a@example.test', consent: 'on', noticeVersion: '1' })) f.set(k, v);
      const r = await apply(new NextRequest(`${origin}/careers/fictional-co/jobs/${JOB}`, { method: 'POST', body: f, headers: { 'x-aihr-request-source': '192.0.2.10' } }),
        { params: Promise.resolve({ address: 'fictional-co', jobId: JOB }) });
      expect(r.status).toBe(503);
      const body = await r.text();
      expect(body).toContain('Online applications are not available right now.');
      expect(body).not.toContain('not accepting applications');
      expect(log.mock.calls).toEqual([['careers request failed', 'submit', 'TypeError', '']]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('a source that has used its hourly submissions is refused before its body is read', () => {
  it('answers 429 without pulling the body, reading the job or submitting', async () => {
    environment({ ...internal, AIHR_TRUST_REQUEST_SOURCE: '1' });
    service.careersClientLimited.mockResolvedValue(true);
    const { POST: apply } = await import('../app/careers/[address]/jobs/[jobId]/route');
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024 * 1024)); } });
    const r = await apply(new NextRequest(`${origin}/careers/fictional-co/jobs/${JOB}`, { method: 'POST', body,
      headers: { 'x-aihr-request-source': '192.0.2.10', 'content-type': 'multipart/form-data; boundary=x' }, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]),
      { params: Promise.resolve({ address: 'fictional-co', jobId: JOB }) });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
    expect(await r.text()).toContain('Too many applications from this connection. Try again later.');
    expect(service.careersClientLimited).toHaveBeenCalledTimes(1);
    expect(service.careersClientLimited.mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(service.careersPublicJob).not.toHaveBeenCalled();
    expect(service.submitCareersApplication).not.toHaveBeenCalled();
  });
});
