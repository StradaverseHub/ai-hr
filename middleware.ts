import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Demo access gate (see HOSTING.md). When SHARE_PASSWORD is set, the whole app sits behind HTTP Basic
 * auth so it can be safely exposed (LAN or a tunnel) for testing — the app itself has no login yet
 * (the dev-session identity switcher is the "auth"). With SHARE_PASSWORD unset (normal local dev), the
 * gate is a no-op. Any username works; only the password is checked.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function middleware(req: NextRequest) {
  // The gate is a hosting protection only — never gate local `next dev`, even if SHARE_PASSWORD is set
  // in .env.local for hosting.
  if (process.env.NODE_ENV === 'development') return NextResponse.next();
  const password = process.env.SHARE_PASSWORD;
  if (!password) return NextResponse.next(); // gate disabled

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6)); // "user:pass"
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(pass, password)) return NextResponse.next();
    } catch {
      // malformed header → fall through to challenge
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="AI HR demo", charset="UTF-8"' },
  });
}

// Gate everything except Next's static assets and the favicon.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
