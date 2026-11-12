'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';

/**
 * 82748f92 — the unsaved-changes check on the People › Settings section pages. Mount once per page.
 *
 * Reuses the Attendance settings guard (form snapshots, beforeunload, in-app link clicks including Back to
 * Settings and the menu, browser Back) with the People strings, and also counts formless editors that register
 * with lib/unsaved-changes.ts (the System Labels and Profile Options grids). Cancel keeps the edits; leaving
 * never saves anything. Baselines are re-taken whenever the search string changes, because these pages' server
 * actions redirect back to the same address with ?toast= after a successful save.
 */
export function PeopleSettingsNavigation() {
  const t = useTranslations('peopleSettingsHub');
  const search = useSearchParams()?.toString() ?? '';
  return (
    <AttendanceSettingsNavigation
      includeRegisteredGuards
      resetKey={search}
      messages={{ leaveUnsaved: t('leaveUnsaved'), leaveOtherUnsaved: t('leaveOtherUnsaved') }}
    />
  );
}
