/**
 * The mobile API's path (ADR-0088 §2), in ONE place, because two mechanisms must agree about it: the
 * route handlers under `app/api/mobile/` and the middleware that lets them past the share gate.
 *
 * Modelled on lib/health-route.ts and lib/auth-routes.ts, including the rule those files exist to keep:
 * the bypass lives in the middleware FUNCTION BODY, never in the matcher, so the fail-closed refusal for
 * an unset SHARE_PASSWORD (readiness 1.4) still runs above it.
 *
 * WHY THE CHALLENGE IS BYPASSED. The gate is HTTP Basic, which occupies the `Authorization` header — the
 * same header the app needs for its bearer token. A request cannot carry both, so behind the gate the API
 * would be unreachable by construction.
 *
 * WHY THAT IS SAFE. Every handler resolves its caller through `getMobileSession()` (lib/session.ts),
 * which accepts ONLY a verified WorkOS bearer token — never the demo `dev_user` cookie — and refuses
 * everything while WORKOS_CLIENT_ID is unset. So behind this bypass there is no unauthenticated door and
 * no way to reach the demo switcher. `mobileRoute()` (lib/mobile-api/handler.ts) is the only way a
 * handler obtains a session, and test/mobile-api-routes.test.ts asserts every route file uses it.
 */
export const MOBILE_API_PREFIX = '/api/mobile';

/** True for `/api/mobile` and anything under it. `/api/mobilexyz` is NOT a match. */
export function isMobileApiRoute(pathname: string): boolean {
  return pathname === MOBILE_API_PREFIX || pathname.startsWith(`${MOBILE_API_PREFIX}/`);
}
