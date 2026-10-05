/**
 * `/health` — readiness 1.6.
 *
 * THE SECOND ARM IS THE ONE THAT MATTERS. Asserting that a healthy system returns healthy is nearly
 * free and nearly worthless: a `return new Response('ok')` passes it. Every claim this endpoint makes
 * is therefore pinned from BOTH sides — the probe fails and the endpoint goes 503, the bypass is
 * absent and the monitor is challenged, the reason is present in the log and absent from the body.
 *
 * Three groups, and they test three different things on purpose:
 *
 *   REACHABILITY   middleware.ts — a monitor gets through the password gate, and a misconfigured
 *                  deployment still refuses. Pinned against the REAL middleware, not a description
 *                  of it.
 *   THE PROBE      lib/health.ts against a REAL postgres client pointed at a REAL dead port. No mock
 *                  can tell you that a refused TCP connection surfaces as a rejection rather than an
 *                  empty result set; this can, and it is the assertion the whole item rests on.
 *   THE ROUTE      app/health/route.ts — that a false verdict becomes 503 and that the body is a
 *                  closed set of two documents, byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import postgres from 'postgres';
import { middleware } from '../middleware';
import { HEALTH_PATH, isHealthRoute } from '../lib/health-route';
import {
  HEALTH_BODY_OK,
  HEALTH_BODY_UNHEALTHY,
  HEALTH_CACHE_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  __resetHealthStateForTests,
  checkHealth,
} from '../lib/health';
// vi.mock below is hoisted above every import in this file, so the route gets the stub, not the pool.
import { GET, HEAD } from '../app/health/route';

/**
 * The route imports the real application pool. Replacing the MODULE — rather than the query — is what
 * lets the route be exercised as written: it still calls `client\`select 1\`` through its own code
 * path, and this stands in for the socket.
 */
const stub = vi.hoisted(() => ({
  calls: 0,
  impl: (): PromiseLike<unknown> => Promise.resolve([{ '?column?': 1 }]),
}));
vi.mock('@/db/client', () => ({
  // Invoked as a tagged template by the route (`client`select 1``); the arguments are irrelevant here.
  client: () => {
    stub.calls += 1;
    return stub.impl();
  },
}));

const req = (path: string, auth?: string) =>
  new NextRequest(`http://localhost${path}`, auth ? { headers: { authorization: auth } } : undefined);
const basic = (pass: string) => 'Basic ' + Buffer.from(`monitor:${pass}`).toString('base64');

beforeEach(() => {
  __resetHealthStateForTests();
  stub.calls = 0;
  stub.impl = () => Promise.resolve([{ '?column?': 1 }]);
  delete process.env.SHARE_PASSWORD;
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.SHARE_PASSWORD;
});

describe('reachability — a health check behind a password is not a health check', () => {
  it('lets an anonymous monitor past the Basic challenge in a gated production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SHARE_PASSWORD = 'sekret';
    const res = await middleware(req(HEALTH_PATH));
    // The full pass-through shape, not `.not.toBe(401)` — a 503, a 500 and a redirect all satisfy that.
    expect(res.status, 'the monitor is not challenged').toBe(200);
    expect(res.headers.get('x-middleware-next'), 'the request reaches the route handler').toBe('1');
    expect(res.headers.get('www-authenticate'), 'no Basic challenge').toBeNull();
  });

  it('CONTROL — the same build still challenges every other path, so the bypass is narrow', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SHARE_PASSWORD = 'sekret';
    const res = await middleware(req('/people'));
    expect(res.status, 'the gate is live in this configuration').toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('does NOT open a namespace: /health/anything is still gated (exact match, not a prefix)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SHARE_PASSWORD = 'sekret';
    expect(isHealthRoute('/health/db')).toBe(false);
    expect((await middleware(req('/health/db'))).status, 'a future sub-route inherits nothing').toBe(401);
  });

  it('still REFUSES when SHARE_PASSWORD is unset — a broken deployment must not report healthy', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await middleware(req(HEALTH_PATH));
    expect(res.status, 'readiness 1.4 sits ABOVE the health bypass, deliberately').toBe(503);
    expect(res.headers.get('x-middleware-next'), 'the route handler never runs').toBeNull();
  });

  it('is reachable with credentials too — a monitor that DOES hold the password is not punished', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SHARE_PASSWORD = 'sekret';
    expect((await middleware(req(HEALTH_PATH, basic('sekret')))).status).toBe(200);
  });
});

describe('the probe — against a real postgres client, not a mock', () => {
  it('a REAL connection to a REAL dead port is UNHEALTHY (the arm the whole item rests on)', async () => {
    // Port 1 on loopback: nothing listens, and the refusal is immediate rather than a timeout.
    const dead = postgres('postgres://nobody:nobody@127.0.0.1:1/nothing', {
      max: 1,
      connect_timeout: 1,
      onnotice: () => {},
    });
    try {
      await expect(checkHealth(() => dead`select 1`)).resolves.toBe(false);
    } finally {
      await dead.end({ timeout: 1 });
    }
  });

  it('a REAL connection to the REAL test database is HEALTHY (the control for the arm above)', async () => {
    const url = process.env.DATABASE_URL;
    expect(url, 'test/env.ts points DATABASE_URL at this worker database').toBeTruthy();
    const live = postgres(url as string, { max: 1, onnotice: () => {} });
    try {
      await expect(checkHealth(() => live`select 1`)).resolves.toBe(true);
    } finally {
      await live.end({ timeout: 5 });
    }
  });

  it('a probe that never answers is unhealthy rather than hanging the monitor', async () => {
    vi.useFakeTimers();
    try {
      const verdict = checkHealth(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS + 10);
      await expect(verdict).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a probe that rejects AFTER the timeout does not become an unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      let reject!: (e: Error) => void;
      const late = new Promise<never>((_r, rj) => {
        reject = rj;
      });
      vi.useFakeTimers();
      const verdict = checkHealth(() => late);
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS + 10);
      vi.useRealTimers();
      await expect(verdict).resolves.toBe(false);
      reject(new Error('the socket finally gave up'));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled, 'a health check must not be able to crash the service it measures').toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('says NOTHING on an ordinary healthy boot — "recovered" must mean something recovered', async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const l = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    const e = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errs.push(String(m)));
    try {
      // A fresh process (beforeEach reset it) whose first probe succeeds. Found by running a dev
      // server and reading its log: the first version announced a recovery on every boot.
      await expect(checkHealth(() => Promise.resolve([{ '?column?': 1 }]))).resolves.toBe(true);
      expect(logs, 'a healthy boot is not an event').toEqual([]);
      expect(errs).toEqual([]);
    } finally {
      l.mockRestore();
      e.mockRestore();
    }
  });

  it('DOES announce a first probe that FAILS — a boot with no database may never transition', async () => {
    const errs: string[] = [];
    const e = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errs.push(String(m)));
    try {
      await expect(checkHealth(() => Promise.reject(new Error('no server')))).resolves.toBe(false);
      expect(errs.join('\n')).toContain('no server');
    } finally {
      e.mockRestore();
    }
  });

  it('writes the reason to the log when the verdict turns bad, and again when it recovers', async () => {
    const errs: string[] = [];
    const logs: string[] = [];
    const e = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errs.push(String(m)));
    const l = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      await checkHealth(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:5432')));
      expect(errs.join('\n'), 'the operator learns WHY from the journal').toContain(
        'connect ECONNREFUSED 10.0.0.9:5432',
      );

      // Same bad verdict again — no second line. The response is the alarm; the journal is not a
      // repeater. Deliberately NOT resetting between the two: the transition memory is what is under test.
      await new Promise((r) => setTimeout(r, HEALTH_CACHE_MS + 20));
      await checkHealth(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:5432')));
      expect(errs, 'one line per transition, not one per probe').toHaveLength(1);

      await new Promise((r) => setTimeout(r, HEALTH_CACHE_MS + 20));
      await checkHealth(() => Promise.resolve([{ '?column?': 1 }]));
      expect(logs.join('\n'), 'recovery is a transition too').toContain('recovered');
    } finally {
      e.mockRestore();
      l.mockRestore();
    }
  });
});

describe('the route — 503 on a broken dependency, and a closed disclosure set', () => {
  it('healthy: 200, exactly {"status":"ok"}, uncacheable', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.text(), 'byte for byte — the disclosure is a closed set').toBe(
      `${JSON.stringify(HEALTH_BODY_OK)}\n`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(stub.calls, 'it actually queried the database rather than answering from nothing').toBe(1);
  });

  it('BROKEN DEPENDENCY: the database is unreachable and the endpoint says 503 unhealthy', async () => {
    stub.impl = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5433'));
    const res = await GET();
    expect(res.status, 'a 200 here would silence the alarm that should fire').toBe(503);
    expect(await res.text()).toBe(`${JSON.stringify(HEALTH_BODY_UNHEALTHY)}\n`);
    expect(stub.calls).toBe(1);
  });

  it('LEAKS NOTHING: not the host, the port, the role, the database, nor the driver error text', async () => {
    stub.impl = () =>
      Promise.reject(
        new Error(
          'connect ECONNREFUSED 10.9.9.9:5999 role=ai_hr_app database=ai_hr_prod host=db.internal ' +
            'CANARY_MUST_NOT_ESCAPE',
        ),
      );
    const res = await GET();
    const body = await res.text();
    const headerText = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const secret of [
      'CANARY_MUST_NOT_ESCAPE',
      'ECONNREFUSED',
      '10.9.9.9',
      '5999',
      'ai_hr_app',
      'ai_hr_prod',
      'db.internal',
    ]) {
      expect(body, `the body must not carry "${secret}"`).not.toContain(secret);
      expect(headerText, `no header may carry "${secret}" either`).not.toContain(secret);
    }
    // And positively: the body is one of exactly two documents, with exactly one key.
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed), 'no version, no build id, no counts, no per-check breakdown').toEqual([
      'status',
    ]);
    expect(['ok', 'unhealthy']).toContain(parsed.status);
  });

  it('HEAD answers with the same verdict and no body (monitors default to it as often as GET)', async () => {
    stub.impl = () => Promise.reject(new Error('down'));
    const res = await HEAD();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is cheap under polling: rapid repeat calls share one round trip', async () => {
    await GET();
    await GET();
    await GET();
    expect(stub.calls, 'the only unauthenticated endpoint must not be a database amplifier').toBe(1);
  });

  it('single flight: concurrent callers share one in-flight probe', async () => {
    let release!: () => void;
    stub.impl = () =>
      new Promise<unknown>((resolve) => {
        release = () => resolve([{ '?column?': 1 }]);
      });
    const all = Promise.all([GET(), GET(), GET()]);
    await new Promise((r) => setImmediate(r));
    expect(stub.calls, 'three simultaneous pollers take one connection, not three').toBe(1);
    release();
    for (const res of await all) expect(res.status).toBe(200);
  });

  it('re-probes once the cache window has passed, so recovery is not masked', async () => {
    stub.impl = () => Promise.reject(new Error('down'));
    expect((await GET()).status).toBe(503);
    stub.impl = () => Promise.resolve([{ '?column?': 1 }]);
    await new Promise((r) => setTimeout(r, HEALTH_CACHE_MS + 20));
    expect((await GET()).status, 'a stale 503 would keep an operator chasing a fixed outage').toBe(200);
    expect(stub.calls).toBe(2);
  });
});
