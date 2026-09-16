/**
 * The health endpoint's path (readiness 1.6), in ONE place, because two mechanisms have to agree
 * about it: the route handler that serves it (`app/health/route.ts`) and the middleware that must let
 * an uptime monitor reach it without credentials (`middleware.ts`).
 *
 * Modelled on `lib/auth-routes.ts` on purpose, including the part that file exists to prevent: the
 * bypass lives in the MIDDLEWARE FUNCTION BODY, never in the matcher. Excluding a path from the
 * matcher skips the whole middleware — which is the redirect-loop bug auth-routes.ts documents — and
 * here it would also remove the only thing that can refuse on this path (see below).
 *
 * ── THE TENSION, AND HOW IT IS RESOLVED ──────────────────────────────────────────────────────────
 *
 * A health check behind a password is not a health check. An uptime monitor that has to hold the
 * shared demo password is a second place that password lives, and a 401 is indistinguishable, to most
 * monitors, from "the app is perfectly fine, you are just anonymous". So the monitor must get through.
 *
 * A health check that leaks internals to the internet is a different problem, and the resolution is
 * NOT to put the endpoint back behind the gate — it is to make the endpoint worth nothing to read.
 * `app/health/route.ts` answers with exactly one of two fixed documents, `{"status":"ok"}` or
 * `{"status":"unhealthy"}`, and nothing else: no version, no commit, no host, no schema, no counts, no
 * database error text. Everything an operator needs to DIAGNOSE goes to the server journal instead,
 * where it is already behind ssh. An anonymous caller learns one bit — a bit they could also obtain by
 * observing that the front door stopped answering.
 *
 * ── WHAT IS BYPASSED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────────────────────
 *
 *   BYPASSED — the HTTP Basic CHALLENGE (the 401). That is the whole point of this file.
 *
 *   NOT BYPASSED — the fail-closed refusal for an unset SHARE_PASSWORD (readiness 1.4, the 503). That
 *     refusal sits ABOVE this bypass in middleware(), and it must stay there. A deployment with no
 *     gate configured is a deployment that refuses to serve; a health endpoint that answered 200
 *     through it would report a broken deployment as healthy, which is precisely the failure mode
 *     readiness 1.6 exists to eliminate. The monitor sees 503 and alarms. That is correct behaviour,
 *     not a gap, and `test/health-route.test.ts` pins it so nobody "fixes" it later.
 *
 * ── WHY EXACT MATCH AND NOT A PREFIX ─────────────────────────────────────────────────────────────
 *
 * `isAuthRoute` matches sub-paths because the login flow genuinely has them (`/callback/...`). This
 * one does not, and a prefix match would open an unauthenticated NAMESPACE rather than a single URL:
 * any future `app/health/<anything>/route.ts` would inherit the bypass silently, by existing. The
 * unauthenticated surface of this application should be enumerable, and it is: one path, this one.
 */
export const HEALTH_PATH = '/health';

/** True only for the health endpoint itself. Exact match — see "why exact match" above. */
export function isHealthRoute(pathname: string): boolean {
  return pathname === HEALTH_PATH;
}
