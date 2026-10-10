import { keycloakSelected, keycloakReady, keycloakConfig, WEB_SESSION_COOKIE } from '@/lib/identity/config';
import { NextRequest, NextResponse } from 'next/server';
import { applyResponseHeaders, authkit, handleAuthkitHeaders, partitionAuthkitHeaders } from '@workos-inc/authkit-nextjs';
import { isAuthRoute } from '@/lib/auth-routes';
import { appOrigin, realAuthEnabled } from '@/lib/real-auth';
import { isHealthRoute } from '@/lib/health-route';
import { isMobileApiRoute } from '@/lib/mobile-api/routes';

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
 *
 * ── r390 — REAL WORKOS SIGN-IN (readiness 1.3) ────────────────────────────────────────────────────
 *
 * That reviewed change is this one, and it keeps the invariant rather than the variable: a deployment
 * serves only when SOMETHING guards it. Either the demo gate (SHARE_PASSWORD) or real sign-in
 * (lib/real-auth.ts: switcher off AND every AuthKit setting present). With neither, the 503 above every
 * bypass stands exactly as before, and deploy/deploy.sh refuses to deploy.
 *
 * With real sign-in on, AuthKit runs here on every request except /health and the bearer-token mobile
 * API. Two reasons it MUST be here, both measured against @workos-inc/authkit-nextjs 4.2.0:
 *   1. `withAuth()` (lib/workos.ts → getSession) THROWS "isn't covered by the AuthKit middleware" unless
 *      this function forwarded AuthKit's headers. Every test mocks lib/workos, so none could see it.
 *   2. `getSignInUrl()` stores its PKCE verifier with cookies().set, which a Server Component (/login)
 *      may not do. Signed-out requests are therefore redirected to AuthKit FROM HERE, where the SDK sets
 *      that cookie on the redirect response itself.
 * And it fails closed like the Basic gate did: a page with no WorkOS session redirects to sign-in and an
 * API or server-action request gets 401, before any route handler runs. Only /callback, /invite and
 * /reset-password are reachable signed out.
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
  if (keycloakSelected()) {
    for (const key of [...requestHeaders.keys()]) if (key.startsWith('x-workos-') || key.startsWith('x-authkit-')) requestHeaders.delete(key);
  }
  requestHeaders.set('x-pathname', req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * The text a misconfigured deployment serves, and the text it logs. Deliberately says what is wrong and
 * where to fix it: the person who meets this is an operator staring at a box, not an end user, and the
 * failure mode this replaces was one nobody could see at all.
 */
const GATE_UNCONFIGURED =
  'AI HR is not configured to serve. SHARE_PASSWORD is unset outside development and real WorkOS sign-in ' +
  'is not fully configured, so nothing guards this build and it refuses to serve rather than run open. ' +
  'Set SHARE_PASSWORD in .env.production, or set WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD ' +
  'and NEXT_PUBLIC_WORKOS_REDIRECT_URI with ALLOW_DEMO_SESSION off, and redeploy (deploy/deploy.sh refuses ' +
  'without one of them).';

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

/** True for requests that cannot follow a redirect to AuthKit: route handlers and server actions. */
function wantsStatusNotRedirect(req: NextRequest): boolean {
  return req.nextUrl.pathname.startsWith('/api/') || req.headers.has('next-action');
}

/**
 * The request as the BROWSER addressed it. Behind the Cloudflare tunnel the app sees http://127.0.0.1:3000,
 * and the SDK derives the PKCE verifier cookie's Secure flag from request.url (authkit-nextjs 4.2.0
 * pkce.js), so on the local address the browser would be handed that cookie without Secure. AuthKit is
 * shown a header-only copy addressed to the public origin; the original request still continues. Its body
 * is not needed here: AuthKit reads only the URL, the method and the headers (cookies included).
 */
function asPublicRequest(req: NextRequest): NextRequest {
  const origin = appOrigin();
  if (!origin || req.nextUrl.origin === origin) return req;
  return new NextRequest(new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, origin), {
    method: req.method,
    headers: req.headers,
  });
}

async function withWorkosSession(original: NextRequest): Promise<NextResponse> {
  const req = asPublicRequest(original);
  const path = req.nextUrl.pathname;
  const { session, headers, authorizationUrl } = await authkit(req, {
    redirectUri: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
  });
  const signedIn = Boolean(session.user);
  // /login is the front door: signed out it goes straight to AuthKit. Signed IN it renders the page, which
  // sends a linked user home and tells an unlinked one why they are not in (redirecting home here instead
  // looped forever for a WorkOS login with no AI HR account: home → AuthRequiredError → /login → home).
  // The other auth routes (/callback, /invite, /reset-password) must work signed out.
  if (!signedIn && (path === '/login' || !isAuthRoute(path))) {
    if (wantsStatusNotRedirect(req)) {
      const { responseHeaders } = partitionAuthkitHeaders(req, headers);
      return applyResponseHeaders(new NextResponse('Authentication required.', { status: 401 }), responseHeaders);
    }
    return handleAuthkitHeaders(req, headers, { redirect: authorizationUrl });
  }
  // Pass through with AuthKit's request headers (withAuth reads them) AND x-pathname (the layout reads it).
  const { requestHeaders, responseHeaders } = partitionAuthkitHeaders(req, headers);
  requestHeaders.set('x-pathname', path);
  return applyResponseHeaders(NextResponse.next({ request: { headers: requestHeaders } }), responseHeaders);
}

export function middleware(req: NextRequest): NextResponse | Promise<NextResponse> {
  // FIRST, above every bypass below, because this is not a question about THIS request — it is a
  // question about whether this deployment is configured to serve anything at all.
  if (keycloakSelected()) {
    if (!keycloakReady()) return refuseUnconfigured();
    const path = req.nextUrl.pathname;
    if (isAuthRoute(path) || isHealthRoute(path) || isMobileApiRoute(path) || req.cookies.has(WEB_SESSION_COOKIE)) return withPathname(req);
    if (wantsStatusNotRedirect(req)) return new NextResponse('Authentication required.', { status: 401, headers: { 'cache-control': 'no-store' } });
    const destination = new URL('/login/start', keycloakConfig().origin);
    destination.searchParams.set('returnTo', path + req.nextUrl.search);
    return NextResponse.redirect(destination);
  }
  const password = process.env.SHARE_PASSWORD;
  const realAuth = realAuthEnabled();
  if (!password && !realAuth) {
    if (process.env.NODE_ENV !== 'development') return refuseUnconfigured();
    // `next dev`, no gate configured: the one and only ungated path.
    return withPathname(req);
  }

  // READINESS 1.6 — the health endpoint bypasses the CHALLENGE but not the refusal above it.
  //
  // It sits BELOW the unconfigured check on purpose and the order is the whole design: a deployment
  // with no SHARE_PASSWORD is not serving, so /health must answer 503 there too and the monitor must
  // alarm. A health endpoint hoisted above that refusal would report a broken deployment as healthy,
  // which is the failure mode 1.6 exists to remove. See lib/health-route.ts.
  if (isHealthRoute(req.nextUrl.pathname)) return withPathname(req);

  // ADR-0088 — the mobile API bypasses the CHALLENGE (Basic auth and the app's bearer token both need the
  // Authorization header) but, like /health, not the refusal above. Every handler behind it accepts only
  // a verified WorkOS bearer token; see lib/mobile-api/routes.ts.
  if (isMobileApiRoute(req.nextUrl.pathname)) return withPathname(req);

  // The Basic-auth challenge applies only while a demo password is configured (with real sign-in it is an
  // optional outer layer for the changeover). Auth routes bypass it but STILL run through here, so
  // x-pathname is set. They used to be excluded in the matcher instead, which skipped this function
  // entirely and left x-pathname unset on exactly the routes whose layout depends on it — see
  // lib/auth-routes.ts. The gate is a hosting protection only — never gate local `next dev`, even if
  // SHARE_PASSWORD is set in .env.local for hosting.
  if (password && !isAuthRoute(req.nextUrl.pathname) && process.env.NODE_ENV !== 'development' && !basicPasses(req, password)) {
    return new NextResponse('Authentication required.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="AI HR demo", charset="UTF-8"' },
    });
  }

  return realAuth ? withWorkosSession(req) : withPathname(req);
}

function basicPasses(req: NextRequest, password: string): boolean {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6)); // "user:pass"
    return safeEqual(decoded.slice(decoded.indexOf(':') + 1), password);
  } catch {
    return false; // malformed header → challenge
  }
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
