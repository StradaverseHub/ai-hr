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
  const switcherOn = env.NODE_ENV !== 'production' || env.ALLOW_DEMO_SESSION === 'true';
  return !switcherOn && missingWorkosSettings(env).length === 0;
}

/** The public origin users reach the app on (https://aihr.stradaverse.ai), taken from the redirect URI.
 *  Behind the Cloudflare tunnel the app itself sees http://127.0.0.1:3000, so every absolute URL it builds
 *  for a browser must come from here. Undefined when the redirect URI is unset or not a URL. */
export function appOrigin(env: Env = process.env): string | undefined {
  try {
    return new URL(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? '').origin;
  } catch {
    return undefined;
  }
}
