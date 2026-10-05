import { NextRequest, NextResponse } from 'next/server';
import { demoSwitcherEnabled } from '@/lib/demo-mode';
import { signInUrl } from '@/lib/workos';

/** AuthKit writes its one-time PKCE cookie here, where Next permits cookie mutation. */
export async function GET(request: NextRequest) {
  if (demoSwitcherEnabled()) return NextResponse.redirect(new URL('/login', request.url));

  // Only the two application-owned destinations use this endpoint. An arbitrary return URL is not
  // needed, and could carry an external redirect or send a completed login into another auth loop.
  const returnTo = request.nextUrl.searchParams.get('returnTo') ?? '/';
  if (returnTo !== '/' && !/^\/invite\/[A-Za-z0-9_-]{1,256}\/activate$/.test(returnTo)) {
    return new NextResponse('Invalid sign-in destination.', { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.redirect(await signInUrl(returnTo), { headers: { 'Cache-Control': 'no-store' } });
}
