'use client';

import { useTranslations } from 'next-intl';
import { CalendarDays, CalendarRange } from 'lucide-react';
import type { CalendarView } from '@/lib/leave-calendar-range';
import {
  SEGMENTED_BTN,
  SEGMENTED_BTN_ACTIVE,
  SEGMENTED_BTN_INACTIVE,
  SEGMENTED_GROUP,
} from '@/lib/segmented-control';

/**
 * Week View / Month View segmented switch for the dashboard Leave Calendar (item ee55f5fe).
 *
 * ed76f6b0: now CONTROLLED, exactly like its sibling AbsenceViewSwitch — the page fetches the full
 * month-covering window up front (resolveCalendarFetchWindow), so toggling is a purely client-side
 * re-slice owned by PlannedAbsencesPanel: zero network, no router navigation, no dashboard reload.
 * The panel's onChange re-anchors via reanchorForView, syncs ?cal/?abs with history.replaceState,
 * and keeps the `leave_calendar_view` session-cookie write — this component only renders the tabs.
 * Classes come from the shared segmented-control family so both switches and the date navigation
 * stay one visual unit (same h-7 height, rounding, hover feel).
 */
export function CalendarRangeSwitch({
  view,
  onChange,
}: {
  view: CalendarView;
  onChange: (next: CalendarView) => void;
}) {
  const t = useTranslations('components.plannedAbsences');

  const go = (next: CalendarView) => {
    if (next !== view) onChange(next);
  };

  return (
    <div role="tablist" aria-label={t('rangeSwitchLabel')} className={SEGMENTED_GROUP}>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'week'}
        onClick={() => go('week')}
        className={`${SEGMENTED_BTN} ${view === 'week' ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_INACTIVE}`}
      >
        <CalendarRange className="size-3.5" />
        {t('viewWeek')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'month'}
        onClick={() => go('month')}
        className={`${SEGMENTED_BTN} ${view === 'month' ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_INACTIVE}`}
      >
        <CalendarDays className="size-3.5" />
        {t('viewMonth')}
      </button>
    </div>
  );
}
