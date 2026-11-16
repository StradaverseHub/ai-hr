/**
 * Recruitment slice 25 — request handling for the agency portal routes: the session cookie (HttpOnly, SameSite=Strict, Secure on
 * https, scoped to the portal's own path, 8 hours). SameSite=Strict is the cross-site request guard: a form posted from another site
 * carries no cookie and is answered as signed out. (The pages send no Referer and so browsers send `Origin: null` on their own
 * form posts; an Origin check would refuse them.)
 */
import type { NextRequest, NextResponse } from 'next/server';
import { AGENCY_PORTAL_COOKIE, agencyPortalPath } from '../../lib/careers-route';
import { AGENCY_PORTAL_SESSION_HOURS } from '@/packs/recruitment/service';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function portalToken(request: NextRequest): string | null {
  const value = request.cookies.get(AGENCY_PORTAL_COOKIE)?.value ?? null;
  return value && TOKEN.test(value) ? value : null;
}

const secure = (origin: string) => origin.startsWith('https://');

export function setPortalCookie(response: NextResponse, address: string, token: string, origin: string): NextResponse {
  response.cookies.set(AGENCY_PORTAL_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secure(origin), path: agencyPortalPath(address),
    maxAge: AGENCY_PORTAL_SESSION_HOURS * 3600 });
  return response;
}

export function clearPortalCookie(response: NextResponse, address: string, origin: string): NextResponse {
  response.cookies.set(AGENCY_PORTAL_COOKIE, '', { httpOnly: true, sameSite: 'strict', secure: secure(origin), path: agencyPortalPath(address), maxAge: 0 });
  return response;
}
