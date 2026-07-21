/**
 * The routes that make up the login flow (ADR-0072): they render WITHOUT the authenticated app shell,
 * WITHOUT the getSession gate, and WITHOUT the SHARE_PASSWORD demo gate.
 *
 * Single source of truth on purpose. This list previously existed twice — once as AUTH_ROUTE_PREFIXES
 * in app/layout.tsx (to skip the shell) and once inside the middleware matcher regex (to skip Basic
 * auth) — and the two mechanisms silently cancelled each other out: excluding these paths from the
 * matcher meant middleware never ran for them, so the `x-pathname` header it sets was absent exactly
 * where the layout needed it to detect an auth route. The layout then rendered the full shell and ran
 * the session gate on /login itself, which is the redirect loop the bypass exists to prevent.
 *
 * Keep them derived from one constant so the two can never drift apart again.
 */
export const AUTH_ROUTE_PREFIXES = ['/login', '/callback', '/invite', '/reset-password'] as const;

/** True when `pathname` is part of the login flow (exact match or a sub-path). */
export function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
