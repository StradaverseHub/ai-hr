import { internalSelected, internalReady, internalConfig, INTERNAL_SESSION_COOKIE } from '@/lib/internal-auth/config';
import { readSessionHandle } from '@/lib/identity/cookie';
import { authProviderInvalid, keycloakSelected, keycloakReady, keycloakConfig, WEB_SESSION_COOKIE } from '@/lib/identity/config';
import { NextRequest, NextResponse } from 'next/server';
import { applyResponseHeaders, authkit, handleAuthkitHeaders, partitionAuthkitHeaders } from '@workos-inc/authkit-nextjs';
import { isAuthRoute } from '@/lib/auth-routes';
import { appOrigin, realAuthEnabled } from '@/lib/real-auth';
import { isHealthRoute } from '@/lib/health-route';
import { isMobileApiRoute } from '@/lib/mobile-api/routes';
import {isLetterVerificationRoute} from '@/lib/letter-verification';
import {isPublicEmailAssetRead} from '@/lib/email-design/asset-route';

/**
 * Authentication routing and demo access protection.
 *
 * ADR-0117 owns the approved embedded HR login, MFA and recovery direction. The internal provider
 * branch runs first; Keycloak and WorkOS remain configuration-selected compatibility paths. Their
 * presence here does not establish activation or acceptance on any installation. Follow
 * deploy/internal-auth/README.md for a reviewed installation change, preserving fail-closed access.
 *
 * Provider selection/readiness checks precede route bypasses. Middleware routing is not a substitute
 * for the authoritative server-side session and authorization checks. Auth routes remain in the
 * matcher so x-pathname reaches the layout without incorrectly requiring the authenticated shell.
 *
 * In the legacy WorkOS/demo branch, realAuthEnabled() or SHARE_PASSWORD must guard non-development
 * requests; otherwise the middleware refuses to serve. The demo HTTP Basic gate checks the shared
 * password, accepts any username and does not authenticate individual employees (see HOSTING.md).
 * Auth-route and health/mobile/letter-verification bypasses retain their own handler checks.
 *
 * Only the legacy WorkOS helper uses AuthKit. It forwards the headers required by withAuth() and
 * creates the PKCE verifier cookie on its redirect response, rather than in a Server Component.
 * Status-only endpoints receive an authentication refusal instead of a sign-in redirect.
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
  if (keycloakSelected() || internalSelected()) {
    for (const key of [...requestHeaders.keys()]) if (key.startsWith('x-workos-') || key.startsWith('x-authkit-')) requestHeaders.delete(key);
  }
  requestHeaders.set('x-pathname', req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * Compatibility operator-response text for configuration refusal. Its legacy WorkOS wording does not
 * define the approved authentication direction; provider selection/readiness is checked by the callers.
 * Keep response behavior separate from the installation guidance in ADR-0117.
 */
const GATE_UNCONFIGURED =
  'AI HR is not configured to serve. SHARE_PASSWORD is unset outside development and real WorkOS sign-in ' +
  'is not fully configured, so nothing guards this build and it refuses to serve rather than run open. ' +
  'Set SHARE_PASSWORD in .env.production, or set WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD ' +
  'and NEXT_PUBLIC_WORKOS_REDIRECT_URI with ALLOW_DEMO_SESSION off, and redeploy (deploy/deploy.sh refuses ' +
  'without one of them).';

/**
 * Log configuration refusal once per process rather than repeating the same message for every 503.
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

/** True for API/export requests and server actions that require a status rather than a login redirect. */
function wantsStatusNotRedirect(req: NextRequest): boolean {
  return req.nextUrl.pathname.startsWith('/api/') || (req.nextUrl.pathname==='/letters/reports/export'||req.nextUrl.pathname==='/letters/templates/options'||/^\/letters\/register\/[0-9a-f-]{36}\/document$/i.test(req.nextUrl.pathname)||/^\/letters\/settings\/assets\/[0-9a-f-]{36}$/i.test(req.nextUrl.pathname)) || req.headers.has('next-action');
}

/**
 * Legacy WorkOS helper: present the request to AuthKit as the browser addressed it. A local proxy may
 * expose http://127.0.0.1:3000 to the app. AuthKit derives its PKCE cookie's Secure flag from request.url,
 * so use a header-only copy addressed to the public origin; the original request still continues.
 * AuthKit reads only the URL, method and headers (cookies included), not the request body.
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
  // In this legacy WorkOS helper, signed-out /login goes to AuthKit. Signed in, it renders the page, which
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
  if (authProviderInvalid()) return refuseUnconfigured();
  if (internalSelected()) {
    if (!internalReady()) return refuseUnconfigured();
    const path = req.nextUrl.pathname;
    if (isAuthRoute(path) || isHealthRoute(path) || isMobileApiRoute(path) || isLetterVerificationRoute(path) || isPublicEmailAssetRead(path,req.method)) return withPathname(req);
    if (/^[A-Za-z0-9_-]{43}$/.test(req.cookies.get(INTERNAL_SESSION_COOKIE)?.value || '')) return withPathname(req);
    if (wantsStatusNotRedirect(req)) return new NextResponse('Authentication required.', { status: 401, headers: { 'cache-control': 'no-store' } });
    const destination = new URL('/login', internalConfig().origin);
    destination.searchParams.set('returnTo', path + req.nextUrl.search);
    return NextResponse.redirect(destination);
  }
  if (keycloakSelected()) {
    if (!keycloakReady()) return refuseUnconfigured();
    const path = req.nextUrl.pathname;
    if (isAuthRoute(path) || isHealthRoute(path) || isMobileApiRoute(path) || isLetterVerificationRoute(path) || isPublicEmailAssetRead(path,req.method)) return withPathname(req);
    return withKeycloakSession(req);
  }
  const password = process.env.SHARE_PASSWORD;
  const realAuth = realAuthEnabled();
  if (!password && !realAuth) {
    if (process.env.NODE_ENV !== 'development') return refuseUnconfigured();
    // `next dev`, no gate configured: the one and only ungated path.
    return withPathname(req);
  }

  // In this legacy WorkOS/demo branch, health bypasses the Basic challenge only after configuration
  // readiness. With neither a demo password nor configured sign-in outside development, the refusal
  // above also applies to health. See lib/health-route.ts.
  if (isHealthRoute(req.nextUrl.pathname)) return withPathname(req);
  if (isLetterVerificationRoute(req.nextUrl.pathname)) return withPathname(req);
  // Assets contain only validated raster bytes and use unguessable tokens. Provider readiness above
  // still owns admission; mail proxies receive no HR session or administrative endpoint access.
  if (isPublicEmailAssetRead(req.nextUrl.pathname,req.method)) return withPathname(req);

  // Mobile API requests bypass the Basic challenge because bearer authentication uses the same
  // Authorization header. Their handlers still own token/session verification and authorization;
  // this bypass grants no HR access. See lib/mobile-api/routes.ts.
  if (isMobileApiRoute(req.nextUrl.pathname)) return withPathname(req);

  // In this legacy WorkOS/demo branch, Basic auth applies while a demo password is configured, including
  // as an outer layer when legacy sign-in is configured. Auth routes bypass it but run through here, so
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

async function withKeycloakSession(req: NextRequest): Promise<NextResponse> {
  if (await readSessionHandle(req.cookies.get(WEB_SESSION_COOKIE)?.value)) return withPathname(req);
  if (wantsStatusNotRedirect(req)) return new NextResponse('Authentication required.', { status: 401, headers: { 'cache-control': 'no-store' } });
  const destination = new URL('/login/start', keycloakConfig().origin);
  destination.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(destination);
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
