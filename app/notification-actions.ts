'use server';

import { onboardingReadNotice } from '@/packs/lifecycle/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import {scopedSession} from '@/lib/scope';
import { markAllNotificationsRead, markNotificationRead } from '@/core/notifications';
import { bellNotificationScope, readBellNotifications } from './bell-notifications';
import type { BellNotifications } from '@/lib/bell-notifications';

/**
 * ADR 0181 decision 4: marking a notification read changes only the bell. The action returns the bell's fresh
 * notification half instead of revalidating the root layout, so the app frame (menus, access checks, approval facts)
 * is not drawn again. The bell's client applies it. A failed re-read returns null and the bell refreshes the route,
 * as before.
 */
async function freshBell(s: Awaited<ReturnType<typeof scopedSession>>['s'], scopeIds: string[]): Promise<BellNotifications | null> {
  try {
    return await readBellNotifications(s, bellNotificationScope(s, scopeIds), isModuleEnabledOrFalse(s, 'lifecycle'));
  } catch (error) {
    console.error('Bell re-read after mark-read failed', error);
    return null;
  }
}

/** Mark one notification read (RLS confines it to the caller's own). */
export async function markNotificationReadAction(id: string): Promise<BellNotifications | null> {
  const {s,scopeIds}=await scopedSession();
  if(id.startsWith('onb:'))await onboardingReadNotice(s,id.slice(4));
  else await markNotificationRead(s,id);
  return freshBell(s,scopeIds);
}

export async function markAllNotificationsReadAction(): Promise<BellNotifications | null> {
  const {s,scopeIds}=await scopedSession();
  if(isModuleEnabledOrFalse(s,'notifications'))await markAllNotificationsRead(s);
  else {const letterCompanyIds=scopeIds.filter(id=>isModuleEnabledOrFalse(s,'notifications',id));if(letterCompanyIds.length)await markAllNotificationsRead(s,undefined,{letterCompanyIds});}
  if(isModuleEnabledOrFalse(s,'lifecycle'))await onboardingReadNotice(s);
  return freshBell(s,scopeIds);
}
