'use client';

import { type ReactNode, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { AbsenceViewSwitch } from '@/components/absence-view-switch';
import { CalendarRangeSwitch } from '@/components/calendar-range-switch';
import { TimelineNav } from '@/components/timeline-nav';
import { PlannedAbsencesGrid, type GridDay, type GridRow } from '@/components/planned-absences-grid';
import { resolveCalendarRange, type CalendarView } from '@/lib/leave-calendar-range';

/**
 * Client half of the Leave Calendar card (eae550e9 steps 3+4): owns the state its three controls share.
 *
 *  - My/Team is CLIENT state: the read is already team-scoped (step 1), so "team" is every row and "my"
 *    is the viewer's own person row — a pure in-memory filter, zero network on toggle. The `view` search
 *    param is kept in sync via history.replaceState (bookmarkable; replaceState integrates with the App
 *    Router) and the initial state is seeded from it, so shared links and week-stepping both preserve it.
 *  - Week/month navigation runs in a useTransition owned HERE (TimelineNav is a leaf — its pending flag
 *    could never reach the grid): the date control flips to the target window IMMEDIATELY via a local
 *    optimistic value, and the grid renders aria-busy + a dimmed pulse until the server responds. This
 *    makes the wait visible; the server still re-renders the whole dashboard exactly as before.
 *  - The grid remounts on a view change (key={view}): the show-all expansion RESETS (the row count
 *    changes meaning) and any open cancel dialog CLOSES. Scroll position is left alone.
 */
export function PlannedAbsencesPanel({
  header,
  legend,
  rows,
  dayArr,
  days,
  fromMs,
  todayIso,
  from,
  to,
  isDefaultAnchor,
  calView,
  viewerPersonId,
  showViewSwitch,
  initialView,
  emptyLabel,
  employeesLabel,
  showAllLabel,
  showLessLabel,
  cancelAction,
  cancelPillLabel,
  adminCancelAction,
  adminCancelPillLabel,
  selfCancelAction,
  selfCancelPillLabel,
  approvalPillLabel,
}: {
  header: ReactNode;
  legend: ReactNode;
  rows: GridRow[];
  dayArr: GridDay[];
  days: number;
  fromMs: number;
  todayIso: string;
  from: string;
  to: string;
  isDefaultAnchor: boolean;
  calView: CalendarView;
  viewerPersonId: string | null;
  showViewSwitch: boolean;
  initialView: 'my' | 'team';
  emptyLabel: string;
  employeesLabel: string;
  showAllLabel: string;
  showLessLabel: string;
  cancelAction?: (fd: FormData) => void | Promise<void>;
  cancelPillLabel?: string;
  adminCancelAction?: (fd: FormData) => void | Promise<void>;
  adminCancelPillLabel?: string;
  selfCancelAction?: (fd: FormData) => void | Promise<void>;
  selfCancelPillLabel?: string;
  approvalPillLabel?: string;
}) {
  const [view, setView] = useState<'my' | 'team'>(initialView);
  const [isPending, startTransition] = useTransition();
  // Optimistic window start, DERIVED rather than effect-reset: the value remembers which server `from`
  // it was issued against, so the moment the server responds with a NEW `from` the optimistic value is
  // ignored automatically (no setState-in-effect, no cascading render).
  const [optimistic, setOptimistic] = useState<{ target: string; base: string } | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  const effectiveView = showViewSwitch ? view : 'my';
  const visibleRows = effectiveView === 'my' ? rows.filter((r) => r.id === viewerPersonId) : rows;
  const displayFrom = optimistic && optimistic.base === from ? optimistic.target : from;

  const goDate = (anchorIso: string | null) => {
    // Immediate feedback: show the TARGET window's resolved start now (the picker displays what was
    // picked); the transition below flags the grid busy until the server catches up.
    setOptimistic({
      target: resolveCalendarRange({ view: calView, anchorIso: anchorIso ?? todayIso, todayIso }).from,
      base: from,
    });
    const params = new URLSearchParams(searchParams.toString());
    if (anchorIso) params.set('abs', anchorIso);
    else params.delete('abs');
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/?${qs}` : '/', { scroll: false }));
  };

  const changeView = (next: 'my' | 'team') => {
    setView(next);
    // Keep ?view= linkable without a navigation: "my" is the default so the param is dropped.
    const params = new URLSearchParams(window.location.search);
    if (next === 'team') params.set('view', 'team');
    else params.delete('view');
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `/?${qs}` : '/');
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        {header}
        <div className="flex flex-wrap items-center gap-2">
          {showViewSwitch && <AbsenceViewSwitch view={effectiveView} onChange={changeView} />}
          <CalendarRangeSwitch view={calView} from={from} to={to} todayIso={todayIso} />
          <TimelineNav from={displayFrom} isDefault={isDefaultAnchor} mode={calView} onGo={goDate} />
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <>
          <div
            aria-busy={isPending}
            className={cn(isPending && 'pointer-events-none animate-pulse opacity-60')}
          >
            <PlannedAbsencesGrid
              key={effectiveView}
              rows={visibleRows}
              dayArr={dayArr}
              days={days}
              fromMs={fromMs}
              todayIso={todayIso}
              employeesLabel={employeesLabel}
              showAllLabel={showAllLabel}
              showLessLabel={showLessLabel}
              cancelAction={cancelAction}
              cancelPillLabel={cancelPillLabel}
              adminCancelAction={adminCancelAction}
              adminCancelPillLabel={adminCancelPillLabel}
              selfCancelAction={selfCancelAction}
              selfCancelPillLabel={selfCancelPillLabel}
              approvalPillLabel={approvalPillLabel}
            />
          </div>
          {legend}
        </>
      )}
    </>
  );
}
