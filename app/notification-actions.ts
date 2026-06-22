'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { markAllNotificationsRead, markNotificationRead } from '@/core/notifications';

/** Mark one notification read (RLS confines it to the caller's own). */
export async function markNotificationReadAction(id: string): Promise<void> {
  await markNotificationRead(await getSession(), id);
  revalidatePath('/', 'layout');
}

export async function markAllNotificationsReadAction(): Promise<void> {
  await markAllNotificationsRead(await getSession());
  revalidatePath('/', 'layout');
}
