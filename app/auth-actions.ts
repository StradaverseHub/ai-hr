'use server';

import { keycloakSelected } from '@/lib/identity/config';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { logout as logoutService, recordLogout, requestPasswordReset } from '@/core/auth';
import { demoSwitcherEnabled } from '@/lib/demo-mode';
import { signOutDemo } from '@/app/identity-actions';
import { appOrigin } from '@/lib/real-auth';

/**
 * Log the current user out: append app-user.logged-out (auth-audit) then clear/revoke the WorkOS
 * cookie (WorkOS's signOut redirects internally). In dev (no WorkOS session) there is nothing to
 * revoke — just send the user to /login so the action is safe to render everywhere.
 */
export async function logoutAction() {
  if (keycloakSelected()) {
    try {
      const current = await getSession();
      await recordLogout({ tenantId: current.tenantId, userId: current.userId! });
    } catch { /* Authentication/storage outages must not trap this browser in a local session. */ }
    return (await import('@/lib/identity/session')).endIdentitySession();
  }
  let session;
  try {
    session = await getSession();
  } catch (e) {
    if (e instanceof AuthRequiredError) redirect('/login');
    throw e;
  }
  if (demoSwitcherEnabled()) {
    // Dev/demo switcher path — no WorkOS session to revoke. ⚠️ THE COOKIE IS CLEARED NOW: it used to be
    // left in place ("the switcher keeps working"), which meant Log out did not log you out — /login
    // would show the chooser while the old identity was still active behind it. Since /login is the
    // demo's front door, signing out has to actually return you to it signed out.
    await signOutDemo();
    redirect('/login');
  }
  await logoutService({ tenantId: session.tenantId, userId: session.userId! }, undefined, signedOutReturn());
  redirect('/login');
}

/** r390 — WorkOS sends the browser here after sign-out. It must be ABSOLUTE and listed under the environment's
 *  sign-out redirects: behind the tunnel a relative '/login' resolves against nothing the browser can reach. */
function signedOutReturn(): string {
  const origin = appOrigin();
  return origin ? `${origin}/login` : '/login';
}

/**
 * r390 — sign out a WorkOS login that has NO AI HR account linked (the /login "not linked" view). logoutAction
 * cannot serve it: it resolves the session first, and for exactly this user that throws AuthRequiredError and
 * redirects to /login, so the WorkOS session would never end and they could not switch to another account.
 * Nothing to audit against: there is no app_user to attribute the event to.
 */
export async function signOutUnlinkedAction() {
  if (demoSwitcherEnabled()) redirect('/login');
  const { endProviderSession } = await import('@/lib/identity/provider');
  await endProviderSession(signedOutReturn());
  redirect('/login');
}

/** Kick off a password reset (thin over WorkOS). Never reveals whether the email exists. */
export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  if (email) await requestPasswordReset({ email });
  redirect('/reset-password?sent=1');
}
