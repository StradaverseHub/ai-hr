'use server';

import { onboardingReadNotice } from '@/packs/lifecycle/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { revalidatePath } from 'next/cache';
import {scopedSession} from '@/lib/scope';
import type { SessionContext } from '@/db/client';
import { notificationBellScope, readNotificationBellView, type NotificationBellScope } from './notification-bell-view';
import { markAllNotificationsRead, markNotificationRead } from '@/core/notifications';

async function bellAfterWrite(session: SessionContext, scope: NotificationBellScope, lifecycleEnabled: boolean) {
  try {
    return await readNotificationBellView(session, scope, lifecycleEnabled);
  } catch {
    // A committed write still gets a fresh shell if its narrow reply is temporarily unavailable.
    revalidatePath('/', 'layout');
    return null;
  }
}

/** Mark one notification read (RLS confines it to the caller's own). */
export async function markNotificationReadAction(id: string) {
  const {s,scopeIds}=await scopedSession();
  if(id.startsWith('onb:'))await onboardingReadNotice(s,id.slice(4));
  else await markNotificationRead(s,id);
  return bellAfterWrite(s,notificationBellScope(s,scopeIds),isModuleEnabledOrFalse(s,'lifecycle'));
}

export async function markAllNotificationsReadAction() {
  const {s,scopeIds}=await scopedSession();
  const scope=notificationBellScope(s,scopeIds);
  const lifecycleEnabled=isModuleEnabledOrFalse(s,'lifecycle');
  if(scope?.letterCompanyIds)await markAllNotificationsRead(s,undefined,{letterCompanyIds:scope.letterCompanyIds});
  else if(scope)await markAllNotificationsRead(s);
  if(lifecycleEnabled)await onboardingReadNotice(s);
  return bellAfterWrite(s,scope,lifecycleEnabled);
}
