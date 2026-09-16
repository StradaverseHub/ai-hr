import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAuthRoute } from '@/lib/auth-routes';

/**
 * Demo access gate (see HOSTING.md). When SHARE_PASSWORD is set, the whole app sits behind HTTP Basic
 * auth so it can be safely exposed (LAN or a tunnel) for testing. Any username works; only the password
 * is checked.
 *
 * ADR-0072: the real WorkOS login flow (/login, /callback, /invite, /reset-password) must be reachable
 * even when SHARE_PASSWORD is set for a hosted demo, otherwise the OAuth callback + login page would be
 * trapped behind Basic auth. The bypass lives in the function body (isAuthRoute), NOT in the matcher.
 *
 * Also sets `x-pathname` on every request so the root layout can tell whether the current route is an
 * auth route (which must render WITHOUT the authenticated app shell + WITHOUT the getSession gate).
 *
 * ── READINESS 1.4 — THE GATE NOW FAILS CLOSED ────────────────────────────────────────────────────
 *
 * It used to fail OPEN. The line was `if (!password) return withPathname(req); // gate disabled`, which
 * served the ENTIRE application to anyone with no error, no log and nothing in the deploy to notice. A
 * gate whose OFF switch is the ABSENCE of a variable is not a gate: a typo in `.env.production`, a line
 * lost when the env file is rebuilt, or a systemd unit that stops passing EnvironmentFile all produce a
 * wide-open HRIS that still answers 200 to every request.
 *
 * WHAT WAS ACHIEVED, AND WHAT WAS NOT. The readiness survey asks the gate to "refuse to start".
 * Middleware cannot deliver that and it is worth being exact about why: it is invoked per REQUEST, in
 * the edge runtime, long after the server is listening. Throwing here produces one failed response and
 * leaves the process up. So the refusal is in TWO places, and only the first is a real startup refusal:
 *
 *   1. `deploy/deploy.sh` — `: "${SHARE_PASSWORD:?…}"`, next to the MIGRATION_DATABASE_URL guard and
 *      BEFORE the install, the build and the migrations. THIS is the arm that refuses: a box whose
 *      .env.production has no SHARE_PASSWORD never gets a new build, never migrates, and never restarts,
 *      so it cannot come up open. It follows the audit-hash-chain gate's own argument in that file — a
 *      refusal is free when it happens before anything has been touched.
 *   2. THIS function — the backstop for every way the app can be started that did NOT come through
 *      deploy.sh: a hand-run `pnpm start`, a unit file edited in place, a container image, a future
 *      host. It cannot refuse to start, so it refuses to SERVE: 503 on every route.
 *
 * A per-request 503 that nobody reads is weaker than a deploy that refuses — which is exactly why arm 1
 * exists and runs first. Arm 2 is here so that "weaker" is still "closed" rather than "open".
 *
 * WHY THE PREDICATE IS `!== 'development'` AND NOT `=== 'production'`. Failing closed means the OPEN
 * path is the one that has to be named. `next dev` sets NODE_ENV=development and is the only
 * environment allowed to run ungated; everything else — production, test, and a custom server that
 * never set NODE_ENV at all — refuses. Spelling it `=== 'production'` would put every unnamed
 * environment back on the open path, which is the shape of the bug being fixed.
 *
 * WHY `next dev` STILL WORKS. Ordinary local development has no SHARE_PASSWORD and must not need one;
 * the `development` branch below is that guarantee and is pinned from both sides in
 * test/share-gate.test.ts.
 *
 * WHY THE AUTH ROUTES REFUSE TOO. isAuthRoute() bypasses the Basic-auth CHALLENGE, because ADR-0072
 * needs the WorkOS callback reachable through a LIVE gate. A MISSING password is not a gate decision,
 * it is a broken deployment, and /login is the application's front door — so the refusal sits ABOVE
 * the auth bypass and a misconfigured deployment serves nothing at all.
 *
 * TURNING THE GATE OFF ON PURPOSE (readiness 1.3, when the demo moves to real WorkOS logins): delete
 * this gate from this file, in a commit someone reviews. Not by deleting a line from an env file.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function withPathname(req: NextRequest): NextResponse {
  // Propagate the pathname to Server Components (the root layout reads it to detect auth routes).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * The text a misconfigured deployment serves, and the text it logs. Deliberately says what is wrong and
 * where to fix it: the person who meets this is an operator staring at a box, not an end user, and the
 * failure mode this replaces was one nobody could see at all.
 */
const GATE_UNCONFIGURED =
  'AI HR is not configured to serve. SHARE_PASSWORD is unset outside development, so the access gate ' +
  'in middleware.ts cannot be enforced and this build refuses to serve rather than run open. ' +
  'Set SHARE_PASSWORD in .env.production and redeploy (deploy/deploy.sh refuses without it).';

/**
 * Once per process, not once per request. A 503 storm behind a tunnel would otherwise write the same
 * line a few thousand times a minute into a journal that (readiness 1.6) nobody is watching anyway.
 */
let logged = false;

function refuseUnconfigured(): NextResponse {
  if (!logged) {
    logged = true;
    console.error(`✗ SHARE GATE: ${GATE_UNCONFIGURED}`);
  }
  return new NextResponse(GATE_UNCONFIGURED, {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function middleware(req: NextRequest) {
  // FIRST, above every bypass below, because this is not a question about THIS request — it is a
  // question about whether this deployment is configured to serve anything at all.
  const password = process.env.SHARE_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV !== 'development') return refuseUnconfigured();
    // `next dev`, no gate configured: the one and only ungated path.
    return withPathname(req);
  }

  // Auth routes bypass the Basic-auth challenge but STILL run through here, so x-pathname is set.
  // They used to be excluded in the matcher instead, which skipped this function entirely and left
  // x-pathname unset on exactly the routes whose layout depends on it — see lib/auth-routes.ts.
  if (isAuthRoute(req.nextUrl.pathname)) return withPathname(req);

  // The gate is a hosting protection only — never gate local `next dev`, even if SHARE_PASSWORD is set
  // in .env.local for hosting.
  if (process.env.NODE_ENV === 'development') return withPathname(req);

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6)); // "user:pass"
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(pass, password)) return withPathname(req);
    } catch {
      // malformed header → fall through to challenge
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="AI HR demo", charset="UTF-8"' },
  });
}

// Run on everything except Next's static assets and the favicon.
//
// The auth routes are deliberately NOT excluded here any more. They used to be, so that the
// SHARE_PASSWORD gate could not trap them — but excluding a path from the matcher skips the whole
// middleware, including withPathname(), so x-pathname went unset on exactly the routes whose layout
// reads it to decide whether to render the bare shell. The layout then rendered the authenticated
// shell and ran the session gate on /login itself: a redirect loop for anyone not already signed in.
// The Basic-auth bypass now lives in the function body instead (see isAuthRoute above), which keeps
// both guarantees.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
