/**
 * The routes that make up the login flow (ADR-0072): they render WITHOUT the authenticated app shell,
 * WITHOUT the getSession gate, and WITHOUT the SHARE_PASSWORD demo gate.
 *
 * The shell is no longer chosen from this list: the login-flow pages live in the app/(auth) route group with
 * their own root layout, and everything else in app/(app). Separate root layouts make Next.js do a full page
 * load between them, so a session-expiry redirect to /login cannot render inside the old shell (which the
 * previous single layout, switching on `x-pathname`, allowed on client navigations). Middleware still uses
 * this list to let these routes through signed out and past the demo gate; a page added under app/(auth)
 * must be added here too.
 */
export const AUTH_ROUTE_PREFIXES = ['/login', '/callback', '/invite', '/reset-password'] as const;

/** True when `pathname` is part of the login flow (exact match or a sub-path). */
export function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
