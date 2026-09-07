'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { demoSwitcherEnabled } from '@/lib/demo-mode';

/** DEV-ONLY: switch the active principal by setting the `dev_user` cookie that getSession reads. */
export async function actAs(formData: FormData) {
  if (!demoSwitcherEnabled()) return; // no-op in a real deployment; the switcher exists only in dev + demo
  const userId = String(formData.get('userId') ?? '');
  const cookieStore = await cookies();
  if (userId) {
    cookieStore.set('dev_user', userId, { httpOnly: true, sameSite: 'lax', path: '/' });
  } else {
    cookieStore.delete('dev_user');
  }
  revalidatePath('/', 'layout');
}

/**
 * Sign in as a seeded identity from /login, then land in the app.
 *
 * Separate from `actAs` on purpose. `actAs` switches identity from inside the shell and returns you to
 * the page you were on (revalidate, no redirect); this is the FRONT DOOR — there is no page to return
 * to, so it redirects to the dashboard. Sharing one action would mean a redirect the switcher does not
 * want, or a revalidate that leaves the visitor sitting on /login after signing in.
 */
export async function signInAs(formData: FormData) {
  if (!demoSwitcherEnabled()) return;
  const userId = String(formData.get('userId') ?? '');
  if (!userId) return;
  const cookieStore = await cookies();
  cookieStore.set('dev_user', userId, { httpOnly: true, sameSite: 'lax', path: '/' });
  redirect('/');
}

/**
 * Sign out of the demo: clear the chosen identity so the visitor is genuinely signed OUT.
 *
 * ⚠️ THE OLD BEHAVIOUR KEPT THE COOKIE. `logoutAction` redirected to /login and left `dev_user` set,
 * with the comment "the switcher keeps working" — so logging out did not log you out, and /login's
 * chooser would have signed you straight back into the same identity. Now that /login is the front door
 * on the demo, that is exactly the state that must be cleared.
 */
export async function signOutDemo() {
  if (!demoSwitcherEnabled()) return;
  const cookieStore = await cookies();
  cookieStore.delete('dev_user');
}
