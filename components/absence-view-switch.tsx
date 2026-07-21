'use client';

import { useTranslations } from 'next-intl';
import { User, Users } from 'lucide-react';

/**
 * My/Team segmented switch for the dashboard Leave Calendar (item 8c739dda). "my" shows the viewer's own
 * leave only; "team" widens to the viewer's reporting team.
 *
 * eae550e9 step 3: the switch is now CONTROLLED. Both views ship in the initial payload (the read is
 * team-scoped), so toggling is a pure in-memory filter owned by PlannedAbsencesPanel — zero network,
 * no server round-trip. The panel's onChange also syncs the `view` search param via
 * history.replaceState so bookmarks and the back button keep working.
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

  const base =
    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors';
  const active = 'bg-card text-foreground shadow-sm';
  const inactive = 'text-muted-foreground hover:text-foreground';

  return (
    <div
      role="tablist"
      aria-label={t('viewSwitchLabel')}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === 'my'}
        onClick={() => go('my')}
        className={`${base} ${view === 'my' ? active : inactive}`}
      >
        <User className="size-3.5" />
        {t('viewMy')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'team'}
        onClick={() => go('team')}
        className={`${base} ${view === 'team' ? active : inactive}`}
      >
        <Users className="size-3.5" />
        {t('viewTeam')}
      </button>
    </div>
  );
}
