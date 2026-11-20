'use server';

import { onboardingReadNotice } from '@/packs/lifecycle/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { revalidatePath } from 'next/cache';
import { companyContextForPage } from '@/lib/scope';
import { getSession } from '@/lib/session';
import type { SessionContext } from '@/db/client';
import { notificationBellScope, readNotificationBellView, type NotificationBellScope } from './notification-bell-view';
import { markAllNotificationsRead, markNotificationRead } from '@/core/notifications';

async function actionBellScope(session: SessionContext): Promise<NotificationBellScope> {
  if (isModuleEnabledOrFalse(session, 'notifications')) return {};
  const { scopeIds } = await companyContextForPage(session);
  return notificationBellScope(session, scopeIds);
}

async function bellAfterWrite(session: SessionContext, lifecycleEnabled: boolean, writeScope?: NotificationBellScope) {
  try {
    const scope=writeScope===undefined?await actionBellScope(session):writeScope;
    return await readNotificationBellView(session, scope, lifecycleEnabled);
  } catch {
    // A committed write still gets a fresh shell if its narrow reply is temporarily unavailable.
    revalidatePath('/', 'layout');
    return null;
  }
}

/** Mark one notification read (RLS confines it to the caller's own). */
export async function markNotificationReadAction(id: string) {
  const s=await getSession();
  if(id.startsWith('onb:'))await onboardingReadNotice(s,id.slice(4));
  else await markNotificationRead(s,id);
  return bellAfterWrite(s,isModuleEnabledOrFalse(s,'lifecycle'));
}

export async function markAllNotificationsReadAction() {
  const s=await getSession();
  const scope=await actionBellScope(s);
  const lifecycleEnabled=isModuleEnabledOrFalse(s,'lifecycle');
  if(scope?.letterCompanyIds)await markAllNotificationsRead(s,undefined,{letterCompanyIds:scope.letterCompanyIds});
  else if(scope)await markAllNotificationsRead(s);
  if(lifecycleEnabled)await onboardingReadNotice(s);
  return bellAfterWrite(s,lifecycleEnabled,scope);
}
