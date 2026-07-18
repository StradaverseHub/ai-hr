'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { User, Users } from 'lucide-react';

/**
 * My/Team segmented switch for the dashboard Leave Calendar (item 8c739dda). "my" shows the viewer's own
 * leave only; "team" widens to the viewer's reporting team. Drives the `view` search param while preserving
 * the current `abs` week anchor, so switching views never jumps the calendar back to the current week.
 */
export function AbsenceViewSwitch({ view, abs }: { view: 'my' | 'team'; abs: string | null }) {
  const t = useTranslations('components.plannedAbsences');
  const router = useRouter();
  const searchParams = useSearchParams();

  const go = (next: 'my' | 'team') => {
    if (next === view) return;
    const params = new URLSearchParams(searchParams.toString());
    // "my" is the default — drop the param so the URL stays clean; "team" is explicit.
    if (next === 'team') params.set('view', 'team');
    else params.delete('view');
    if (abs) params.set('abs', abs);
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : '/', { scroll: false });
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
