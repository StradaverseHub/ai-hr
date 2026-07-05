'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { logout as logoutService, requestPasswordReset } from '@/core/auth';

/**
 * Log the current user out: append app-user.logged-out (auth-audit) then clear/revoke the WorkOS
 * cookie (WorkOS's signOut redirects internally). In dev (no WorkOS session) there is nothing to
 * revoke — just send the user to /login so the action is safe to render everywhere.
 */
export async function logoutAction() {
  let session;
  try {
    session = await getSession();
  } catch (e) {
    if (e instanceof AuthRequiredError) redirect('/login');
    throw e;
  }
  if (process.env.NODE_ENV !== 'production') {
    // Dev switcher path — no WorkOS session to revoke; the dev cookie stays (developers keep switching).
    redirect('/login');
  }
  await logoutService({ tenantId: session.tenantId, userId: session.userId! }, undefined, '/login');
  redirect('/login');
}

/** Kick off a password reset (thin over WorkOS). Never reveals whether the email exists. */
export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  if (email) await requestPasswordReset({ email });
  redirect('/reset-password?sent=1');
}
