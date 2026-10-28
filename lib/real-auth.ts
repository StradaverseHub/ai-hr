import { internalSelected, internalReady, internalConfig } from './internal-auth/config';
import { authProviderInvalid, keycloakSelected, keycloakReady, keycloakConfig } from './identity/config';
/**
 * r390 — IS THIS DEPLOYMENT ON REAL WORKOS SIGN-IN?
 *
 * Real sign-in replaces both the demo identity switcher and the SHARE_PASSWORD gate (readiness 1.3). It is
 * on only when the switcher is OFF (a production build without ALLOW_DEMO_SESSION=true, lib/demo-mode.ts)
 * AND every setting AuthKit needs is present. Half a configuration is not real sign-in: middleware.ts then
 * still refuses to serve without the gate, and deploy/deploy.sh refuses to deploy, so a missing variable can
 * never turn into an open app (the readiness 1.4 rule this replaces).
 *
 * Edge-safe and pure: read by middleware.ts, deploy-time checks and tests. No 'server-only'.
 */

/** Every variable AuthKit reads. The redirect URI is NEXT_PUBLIC_, so it is inlined at BUILD time: set it
 *  in .env.production before the deploy builds, not just before a restart. */
export const WORKOS_SETTINGS = [
  'WORKOS_API_KEY',
  'WORKOS_CLIENT_ID',
  'WORKOS_COOKIE_PASSWORD',
  'NEXT_PUBLIC_WORKOS_REDIRECT_URI',
] as const;

type Env = Record<string, string | undefined>;

/** The AuthKit settings that are absent or empty. */
export function missingWorkosSettings(env: Env = process.env): string[] {
  return WORKOS_SETTINGS.filter((k) => !env[k]?.trim());
}

/** True when the demo switcher is off and AuthKit is fully configured. Mirrors demoSwitcherEnabled(). */
export function realAuthEnabled(env: Env = process.env): boolean {
  if (authProviderInvalid(env)) return false;
  if (internalSelected(env)) return internalReady(env);
  if (keycloakSelected(env)) return keycloakReady(env);
  const switcherOn = env.NODE_ENV !== 'production' || env.ALLOW_DEMO_SESSION === 'true';
  return !switcherOn && missingWorkosSettings(env).length === 0;
}

/** AUTH_PUBLIC_ORIGIN when no sign-in provider is selected: the shared password with the demo switcher, and
 *  local development. Validated like internalConfig: a canonical origin with no credentials, path, query or
 *  hash. HTTPS only, except http://localhost:<port> or http://127.0.0.1:<port> outside a production build.
 *  Configuration only: never derived from a request's Host, Origin or Forwarded headers. Undefined when the
 *  value is unset or malformed. */
export function configuredPublicOrigin(env: Env = process.env): string | undefined {
  let url: URL;
  try { url = new URL(env.AUTH_PUBLIC_ORIGIN ?? ''); } catch { return undefined; }
  const localDevelopment = env.NODE_ENV !== 'production' && url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if ((url.protocol !== 'https:' && !localDevelopment) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) return undefined;
  return url.origin;
}

/** The public origin users reach the app on (https://hr.example.com): the selected provider's configured
 *  origin; with no provider selected, AUTH_PUBLIC_ORIGIN; last, the retired WorkOS redirect URI.
 *  Behind the Cloudflare tunnel the app itself sees http://127.0.0.1:3000, so every absolute URL it builds
 *  for a browser must come from here. Undefined when nothing usable is configured. A set but malformed
 *  AUTH_PUBLIC_ORIGIN refuses rather than falling back to another variable. */
export function appOrigin(env: Env = process.env): string | undefined {
  try {
    if (internalSelected(env)) return internalConfig(env).origin;
    if (keycloakSelected(env)) return keycloakConfig(env).origin;
    if (env.AUTH_PUBLIC_ORIGIN) return configuredPublicOrigin(env);
    return new URL(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? '').origin;
  } catch {
    return undefined;
  }
}
