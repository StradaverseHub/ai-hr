'use server';

import { onboardingReadNotice } from '@/packs/lifecycle/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { markAllNotificationsRead, markNotificationRead } from '@/core/notifications';

/** Mark one notification read (RLS confines it to the caller's own). */
export async function markNotificationReadAction(id: string): Promise<void> {
  const s=await getSession();
  if(id.startsWith('onb:'))await onboardingReadNotice(s,id.slice(4));
  else await markNotificationRead(s,id);
  revalidatePath('/', 'layout');
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const s=await getSession();
  if(isModuleEnabledOrFalse(s,'notifications'))await markAllNotificationsRead(s);
  if(isModuleEnabledOrFalse(s,'lifecycle'))await onboardingReadNotice(s);
  revalidatePath('/', 'layout');
}
