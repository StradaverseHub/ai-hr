'use server';

import { cookies } from 'next/headers';
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
