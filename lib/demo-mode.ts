import { keycloakSelected, authProviderInvalid } from './identity/config';
/**
 * Demo-mode gate (ADR-0072 follow-up).
 *
 * Real per-user auth (WorkOS) is the production default: getSession() verifies a WorkOS session and the
 * dev identity switcher is compiled out of a real deployment. But the gated CONSULTANT DEMO deliberately
 * keeps the switcher (testers become any seeded role, behind the SHARE_PASSWORD gate) — and it runs in
 * production mode. So this flag re-enables the switcher in production ONLY when explicitly set.
 *
 * OFF by default: a real tenant deployment never sets ALLOW_DEMO_SESSION, so it always gets real WorkOS
 * auth — the ADR-0072 hardening stands everywhere the flag is absent. The demo stays behind SHARE_PASSWORD
 * and uses demo data only. When the demo cuts over to real logins, unset the flag; no code change.
 */
export function demoSwitcherEnabled(): boolean {
  return !authProviderInvalid() && !keycloakSelected() && (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_SESSION === 'true');
}

/**
 * The GATED CONSULTANT DEMO DEPLOYMENT specifically — a production build running with the identity
 * switcher deliberately left on. Distinct from demoSwitcherEnabled(), which is ALSO true in ordinary
 * local development; that difference is the entire point of having a second predicate.
 *
 * Used to fence off the operator console (core/operator.ts + app/operator). On the demo, anyone past
 * SHARE_PASSWORD can become any seeded identity through the switcher, so a consultant kicking the tyres
 * could otherwise reach a screen that creates real customers. A developer running `pnpm dev` locally is
 * not that, and must keep working — hence the NODE_ENV half of the condition rather than a bare flag
 * check. Belt-and-braces: db/seed.ts additionally withholds the operator grant when the flag is set.
 */
export function isDemoDeployment(): boolean {
  return !authProviderInvalid() && !keycloakSelected() && process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SESSION === 'true';
}

// Loud, once-per-process warning when the switcher is live in a production build.
if (isDemoDeployment()) {
  // eslint-disable-next-line no-console
  console.warn(
    '⚠️  DEMO MODE: the dev identity switcher is active in production (ALLOW_DEMO_SESSION=true). ' +
      'This is for the gated consultant demo only — NEVER set it for a real tenant deployment.',
  );
}
