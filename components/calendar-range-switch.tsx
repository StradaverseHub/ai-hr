'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarDays, CalendarRange } from 'lucide-react';
import { reanchorForView, type CalendarView } from '@/lib/leave-calendar-range';

/**
 * Week View / Month View segmented switch for the dashboard Leave Calendar (item ee55f5fe). Same
 * grammar and mechanism as its sibling AbsenceViewSwitch: role=tablist, the same segmented container
 * classes, and a router.push({ scroll: false }) — no server action, no redirect, no scroll jump.
 *
 * Param handling: `cal=month` for month; the param is DELETED for week (the default), keeping URLs
 * clean. A session cookie (`leave_calendar_view`, no max-age so it dies with the browser) remembers
 * the choice across in-session navigations. Before pushing, the CURRENT window is re-anchored via
 * reanchorForView so month → week → month never drifts into the previous month: a window containing
 * today drops ?abs entirely (re-enabling the "Today" reset); otherwise ?abs pins the window midpoint.
 */
export function CalendarRangeSwitch({
  view,
  from,
  to,
  todayIso,
}: {
  view: CalendarView;
  from: string;
  to: string;
  todayIso: string;
}) {
  const t = useTranslations('components.plannedAbsences');
  const router = useRouter();
  const searchParams = useSearchParams();

  const go = (next: CalendarView) => {
    if (next === view) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'month') params.set('cal', 'month');
    else params.delete('cal');
    const anchor = reanchorForView({ fromView: view, toView: next, from, to, todayIso });
    if (anchor === null) params.delete('abs');
    else params.set('abs', anchor);
    // Session memory: cosmetic preference, client-written (NOT httpOnly), no max-age ⇒ session-scoped.
    document.cookie = `leave_calendar_view=${next}; path=/; samesite=lax`;
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
      aria-label={t('rangeSwitchLabel')}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === 'week'}
        onClick={() => go('week')}
        className={`${base} ${view === 'week' ? active : inactive}`}
      >
        <CalendarRange className="size-3.5" />
        {t('viewWeek')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'month'}
        onClick={() => go('month')}
        className={`${base} ${view === 'month' ? active : inactive}`}
      >
        <CalendarDays className="size-3.5" />
        {t('viewMonth')}
      </button>
    </div>
  );
}
