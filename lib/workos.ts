/**
 * WorkOS AuthKit provider seam (ADR-0072).
 *
 * The SINGLE module the rest of the app imports for the WorkOS surface. Every auth code path
 * (getSession, core/auth services, the login / callback / logout routes) goes through here, so:
 *   • tests mock exactly this module (`vi.mock('@/lib/workos', …)`) and never touch the real SDK,
 *     the way existing tests mock `lib/ai` — tsc, vitest and `pnpm build` require NO live WorkOS
 *     connection;
 *   • the concrete WorkOS calls (authkit `withAuth` / `getSignInUrl` / `signOut`, and
 *     `getWorkOS().userManagement.*` for invitations + password resets) are quarantined behind a
 *     small, hand-typed boundary — deep provider types never leak into app code.
 *
 * IMPORTANT: application code must NOT depend on the WorkOS MCP. Environment provisioning (keys,
 * redirect URIs) is a separate, human-confirmed deploy-time step; this module only consumes the
 * env vars WORKOS_API_KEY / WORKOS_CLIENT_ID / WORKOS_COOKIE_PASSWORD at runtime.
 */
import 'server-only';
import { getSignInUrl as authkitGetSignInUrl, signOut as authkitSignOut, withAuth } from '@workos-inc/authkit-nextjs';
import { getWorkOS } from '@workos-inc/authkit-nextjs';

/** The minimal verified-session shape getSession() needs: the WorkOS subject + verified email. */
export type WorkosVerifiedSession = { subject: string; email: string | null } | null;

/**
 * Return the verified WorkOS session for the current request, or null when there is none / it is
 * expired. Never redirects (ensureSignedIn defaults to false), so getSession can map "no session"
 * to a typed AuthRequiredError and control its own redirect. `user.id` is the WorkOS subject.
 */
export async function currentWorkosSession(): Promise<WorkosVerifiedSession> {
  const info = await withAuth();
  if (!info || !info.user) return null;
  return { subject: info.user.id, email: info.user.email ?? null };
}

/** The hosted AuthKit sign-in URL (used by /login). `returnTo` is where WorkOS sends the user post-login. */
export async function signInUrl(returnTo?: string): Promise<string> {
  return authkitGetSignInUrl(returnTo ? { returnTo } : undefined);
}

/** Clear/revoke the WorkOS session cookie and redirect (WorkOS performs the redirect internally). */
export async function endWorkosSession(returnTo?: string): Promise<void> {
  await authkitSignOut(returnTo ? { returnTo } : undefined);
}

/**
 * Send a WorkOS invitation email (WorkOS owns the email + the one-time link + password set). Returns
 * the WorkOS user id (subject) the invitation is bound to, so the caller can pre-bind it if desired.
 * Thin wrapper — WorkOS is the source of truth for delivery, expiry and rate-limiting.
 */
export async function sendProviderInvitation(email: string): Promise<{ invitationId: string }> {
  const wos = getWorkOS();
  // The node SDK exposes userManagement.sendInvitation({ email }); type it narrowly at the boundary.
  const um = wos.userManagement as unknown as {
    sendInvitation: (opts: { email: string }) => Promise<{ id: string }>;
  };
  const res = await um.sendInvitation({ email });
  return { invitationId: res.id };
}

/** Revoke a pending WorkOS invitation (best-effort mirror of our own revoke). */
export async function revokeProviderInvitation(invitationId: string): Promise<void> {
  const wos = getWorkOS();
  const um = wos.userManagement as unknown as {
    revokeInvitation: (id: string) => Promise<unknown>;
  };
  await um.revokeInvitation(invitationId);
}

/** Trigger a WorkOS password-reset email. Thin wrapper; WorkOS owns hashing / reset-token / delivery. */
export async function sendProviderPasswordReset(email: string): Promise<void> {
  const wos = getWorkOS();
  const um = wos.userManagement as unknown as {
    createPasswordReset: (opts: { email: string }) => Promise<unknown>;
    sendPasswordResetEmail?: (opts: { email: string; passwordResetUrl?: string }) => Promise<unknown>;
  };
  // createPasswordReset is the current API; guard for older SDKs exposing sendPasswordResetEmail.
  if (typeof um.createPasswordReset === 'function') await um.createPasswordReset({ email });
  else if (um.sendPasswordResetEmail) await um.sendPasswordResetEmail({ email });
}
