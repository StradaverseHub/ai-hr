/**
 * `GET /health` — readiness 1.6, "a health endpoint exists and is monitored".
 *
 * Reachable WITHOUT the shared password (the bypass is `isHealthRoute` in middleware.ts; the reasoning
 * for bypassing the 401 while deliberately NOT bypassing the 1.4 fail-closed 503 is in
 * lib/health-route.ts). It performs a real database round trip, because a health check that returns
 * 200 while the database is unreachable is worse than having none: it silences the alarm that would
 * otherwise fire. The probe itself, its bounds and what it does and does not prove are in lib/health.ts.
 *
 * ── WHAT THIS DISCLOSES TO AN ANONYMOUS CALLER ───────────────────────────────────────────────────
 *
 * Exactly one bit, as one of two byte-identical documents:
 *
 *     200  {"status":"ok"}
 *     503  {"status":"unhealthy"}
 *
 * and nothing else. NOT the version, the commit, the branch, the build id, the uptime, the hostname,
 * the database host/port/role/name, the driver's error text, the migration watermark, the tenant
 * count, the employee count, the module set, or the list of checks performed. Several of those are
 * conventional in a health payload and every one of them is either a tenant fact or an attacker's
 * reconnaissance on an endpoint that, by design, anyone on the internet can poll.
 *
 * The diagnosis is not withheld, it is REDIRECTED: the failure reason is written to the service
 * journal (`journalctl -u aihr`), which is already behind ssh, and the operator reads it there.
 *
 * `test/health-route.test.ts` pins the disclosure as a closed set — the response body must deep-equal
 * one of the two constants — so a future "just add the version, it is handy" cannot pass silently.
 */
import { client } from '@/db/client';
import { HEALTH_BODY_OK, HEALTH_BODY_UNHEALTHY, checkHealth } from '@/lib/health';

/**
 * Route Handlers are not cached by default in Next 16 (node_modules/next/dist/docs/01-app/
 * 01-getting-started/15-route-handlers.md:51), so this is belt and braces rather than a fix — but it
 * is the belt that matters if Cache Components is ever switched on, because a prerendered health check
 * is a constant 200 baked at build time, which is the exact defect this endpoint exists to avoid.
 */
export const dynamic = 'force-dynamic';

/** postgres.js is a Node driver; the edge runtime cannot open the socket this probe depends on. */
export const runtime = 'nodejs';

function respond(healthy: boolean, withBody: boolean): Response {
  const body = healthy ? HEALTH_BODY_OK : HEALTH_BODY_UNHEALTHY;
  return new Response(withBody ? `${JSON.stringify(body)}\n` : null, {
    status: healthy ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A cached health check is a stale health check, and every layer between here and the monitor
      // (the tunnel, a future nginx, the monitor itself) is entitled to cache a 200 without this.
      'cache-control': 'no-store',
    },
  });
}

/** The same `select 1`, on the same pool every page uses — see lib/health.ts on why it is passed in. */
const probe = () => client`select 1`;

export async function GET(): Promise<Response> {
  return respond(await checkHealth(probe), true);
}

/**
 * Monitors default to HEAD as often as to GET, and Next does not derive one from the other
 * (15-route-handlers.md:43 lists HEAD as a method you export). Without this an unlucky monitor
 * configuration gets 405 on every poll and someone concludes the endpoint is broken.
 */
export async function HEAD(): Promise<Response> {
  return respond(await checkHealth(probe), false);
}
