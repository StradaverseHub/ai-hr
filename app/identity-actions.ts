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
