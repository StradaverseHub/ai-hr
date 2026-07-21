import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAuthRoute } from '@/lib/auth-routes';

/**
 * Demo access gate (see HOSTING.md). When SHARE_PASSWORD is set, the whole app sits behind HTTP Basic
 * auth so it can be safely exposed (LAN or a tunnel) for testing. With SHARE_PASSWORD unset (normal
 * local dev), the gate is a no-op. Any username works; only the password is checked.
 *
 * ADR-0072: the real WorkOS login flow (/login, /callback, /invite, /reset-password) must be reachable
 * even when SHARE_PASSWORD is set for a hosted demo, otherwise the OAuth callback + login page would be
 * trapped behind Basic auth. The matcher below EXCLUDES those paths (in addition to Next's static
 * assets). The gate's own NODE_ENV === 'development' predicate is unchanged.
 *
 * Also sets `x-pathname` on every request so the root layout can tell whether the current route is an
 * auth route (which must render WITHOUT the authenticated app shell + WITHOUT the getSession gate).
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

export function middleware(req: NextRequest) {
  // Auth routes bypass the Basic-auth challenge but STILL run through here, so x-pathname is set.
  // They used to be excluded in the matcher instead, which skipped this function entirely and left
  // x-pathname unset on exactly the routes whose layout depends on it — see lib/auth-routes.ts.
  if (isAuthRoute(req.nextUrl.pathname)) return withPathname(req);

  // The gate is a hosting protection only — never gate local `next dev`, even if SHARE_PASSWORD is set
  // in .env.local for hosting.
  if (process.env.NODE_ENV === 'development') return withPathname(req);
  const password = process.env.SHARE_PASSWORD;
  if (!password) return withPathname(req); // gate disabled

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
