'use client';

import { useTranslations } from 'next-intl';
import { User, Users } from 'lucide-react';
import {
  SEGMENTED_BTN,
  SEGMENTED_BTN_ACTIVE,
  SEGMENTED_BTN_INACTIVE,
  SEGMENTED_GROUP,
} from '@/lib/segmented-control';

/**
 * My/Team segmented switch for the dashboard Leave Calendar (item 8c739dda). "my" shows the viewer's own
 * leave only; "team" widens to the viewer's reporting team.
 *
 * eae550e9 step 3: the switch is now CONTROLLED. Both views ship in the initial payload (the read is
 * team-scoped), so toggling is a pure in-memory filter owned by PlannedAbsencesPanel — zero network,
 * no server round-trip. The panel's onChange also syncs the `view` search param via
 * history.replaceState so bookmarks and the back button keep working.
 *
 * ed76f6b0: classes come from the shared segmented-control family so this switch, the Week/Month
 * switch, and the date navigation stay one visual unit (same h-7 height, rounding, hover feel).
 */
export function AbsenceViewSwitch({
  view,
  onChange,
}: {
  view: 'my' | 'team';
  onChange: (next: 'my' | 'team') => void;
}) {
  const t = useTranslations('components.plannedAbsences');

  const go = (next: 'my' | 'team') => {
    if (next !== view) onChange(next);
  };

  return (
    <div role="tablist" aria-label={t('viewSwitchLabel')} className={SEGMENTED_GROUP}>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'my'}
        onClick={() => go('my')}
        className={`${SEGMENTED_BTN} ${view === 'my' ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_INACTIVE}`}
      >
        <User className="size-3.5" />
        {t('viewMy')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'team'}
        onClick={() => go('team')}
        className={`${SEGMENTED_BTN} ${view === 'team' ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_INACTIVE}`}
      >
        <Users className="size-3.5" />
        {t('viewTeam')}
      </button>
    </div>
  );
}
