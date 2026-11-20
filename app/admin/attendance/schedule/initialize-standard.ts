'use server';

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { assertModuleGate } from '@/core/module-gate';
import { ensureStandardRule } from '@/core/attendance-rule';
import { failScheduleGroup, okScheduleGroup, SCHEDULE_GROUPS } from '../../_redirects';

export async function initializeStandardSchedule() {
  const session = await requireAdmin();
  let created: boolean;
  try {
    assertModuleGate(session, 'attendance');
    ({ created } = await ensureStandardRule(session));
  } catch (error) {
    failScheduleGroup(error, '');
  }
  if (created) {
    const t = await getTranslations('admin.scheduleConfig');
    okScheduleGroup('', t('createdToast'));
  }
  redirect(SCHEDULE_GROUPS);
}
