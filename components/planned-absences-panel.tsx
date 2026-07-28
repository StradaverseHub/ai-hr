'use client';

import { type ReactNode, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { AbsenceViewSwitch } from '@/components/absence-view-switch';
import { CalendarRangeSwitch } from '@/components/calendar-range-switch';
import { TimelineNav } from '@/components/timeline-nav';
import { PlannedAbsencesGrid, type GridRow } from '@/components/planned-absences-grid';
import { reanchorForView, resolveCalendarRange, type CalendarView } from '@/lib/leave-calendar-range';

const MS_DAY = 86_400_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Client half of the Leave Calendar card (eae550e9 steps 3+4 → ed76f6b0): owns the state its three
 * controls share.
 *
 *  - My/Team is CLIENT state: the read is already team-scoped (step 1), so "team" is every row and "my"
 *    is the viewer's own person row — a pure in-memory filter, zero network on toggle. The `view` search
 *    param is kept in sync via history.replaceState (bookmarkable; replaceState integrates with the App
 *    Router) and the initial state is seeded from it, so shared links and week-stepping both preserve it.
 *  - ed76f6b0: Week/Month is now CLIENT state too, mirroring My/Team exactly. The page fetches the full
 *    month-covering window once (resolveCalendarFetchWindow), so toggling is a purely client-side
 *    re-slice: this panel re-resolves the display window (resolveCalendarRange) off a re-anchored value
 *    (reanchorForView — the month → week → month drift fix, unchanged), then syncs ?cal/?abs with
 *    history.replaceState and rewrites the `leave_calendar_view` session cookie. Zero network, no
 *    dashboard re-render — instant, exactly like the My/Team switch.
 *  - Date NAVIGATION still round-trips (new data): it runs in a useTransition owned HERE (TimelineNav is
 *    a leaf — its pending flag could never reach the grid): the date control flips to the target window
 *    IMMEDIATELY via a local optimistic value, and the grid renders aria-busy + a dimmed pulse until the
 *    server responds. This makes the wait visible.
 *  - The grid remounts on a My/Team change (key={view}): the show-all expansion RESETS (the row count
 *    changes meaning) and any open cancel dialog CLOSES. Scroll position is left alone.
 *  - ed76f6b0: the header keeps the IDENTICAL two-row control structure for every role — row 1 is a
 *    fixed h-7 slot that simply stays empty when the viewer has no My/Team switch, so the layout never
 *    reshapes across employee / manager / HR-admin.
 */
export function PlannedAbsencesPanel({
  title,
  legend,
  rows,
  todayIso,
  anchorIso,
  initialCalView,
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
  // item 726ac8c2: the person the Leave Summary's "View Calendar" action deep-linked to. Passed straight
  // through to the grid, which owns the highlight (it alone knows whether the row is in the collapsed set).
  focusPersonId,
}: {
  title: string;
  legend: ReactNode;
  rows: GridRow[];
  todayIso: string;
  /** The validated ?abs= anchor the SERVER rendered with (null ⇒ default/today). */
  anchorIso: string | null;
  initialCalView: CalendarView;
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
  focusPersonId?: string | null;
}) {
  const [view, setView] = useState<'my' | 'team'>(initialView);
  const [calView, setCalView] = useState<CalendarView>(initialCalView);
  // The Week/Month toggle re-anchors CLIENT-side (no round trip), so the effective anchor is a local
  // override, DERIVED rather than effect-reset: it remembers which server `anchorIso` it was issued
  // against, so the moment the server responds with a NEW anchor (a date navigation or an unrelated
  // revalidation) the override is ignored automatically (no setState-in-effect, no cascading render).
  const [anchorOverride, setAnchorOverride] = useState<{
    value: string | null;
    base: string | null;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  // Optimistic window start for date NAVIGATION, same derived pattern keyed to the resolved `from`:
  // it only drives the date control (the grid keeps the old window dimmed until the data arrives).
  const [optimistic, setOptimistic] = useState<{ target: string; base: string } | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  const effectiveAnchor =
    anchorOverride && anchorOverride.base === anchorIso ? anchorOverride.value : anchorIso;
  // The DISPLAY window: resolved locally (pure UTC arithmetic — identical on server render and client,
  // so no hydration drift) off the effective anchor. Week view is a client-side slice of the wider
  // month-covering fetch window the page loaded; the grid clips pills to this window by index.
  const win = resolveCalendarRange({ view: calView, anchorIso: effectiveAnchor, todayIso });
  const fromMs = Date.parse(`${win.from}T00:00:00Z`);
  const dayArr = Array.from({ length: win.days }, (_, i) => {
    const d = new Date(fromMs + i * MS_DAY);
    const dow = d.getUTCDay();
    return {
      iso: d.toISOString().slice(0, 10),
      weekday: WEEKDAY[dow],
      dayNum: d.getUTCDate(),
      isWeekend: dow === 0 || dow === 6,
    };
  });

  const effectiveView = showViewSwitch ? view : 'my';
  const visibleRows = effectiveView === 'my' ? rows.filter((r) => r.id === viewerPersonId) : rows;
  const displayFrom = optimistic && optimistic.base === win.from ? optimistic.target : win.from;

  const goDate = (nextAnchor: string | null) => {
    // Immediate feedback: show the TARGET window's resolved start now (the picker displays what was
    // picked); the transition below flags the grid busy until the server catches up.
    setOptimistic({
      target: resolveCalendarRange({ view: calView, anchorIso: nextAnchor ?? todayIso, todayIso }).from,
      base: win.from,
    });
    const params = new URLSearchParams(searchParams.toString());
    if (nextAnchor) params.set('abs', nextAnchor);
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

  // ed76f6b0: the Week/Month toggle, mirroring changeView — pure client state + URL/cookie sync, zero
  // network. Re-anchors off the CURRENT window first (reanchorForView, unchanged rule) so month → week
  // → month never drifts: a window containing today drops ?abs entirely (re-enabling the "Today"
  // reset); otherwise ?abs pins the window midpoint. ?cal=month is set for month and DELETED for week
  // (the default), keeping URLs clean; the session cookie (`leave_calendar_view`, no max-age so it dies
  // with the browser) remembers the choice across in-session navigations exactly as before.
  const changeCalView = (next: CalendarView) => {
    if (next === calView) return;
    const anchor = reanchorForView({
      fromView: calView,
      toView: next,
      from: win.from,
      to: win.to,
      todayIso,
    });
    setCalView(next);
    setAnchorOverride({ value: anchor, base: anchorIso });
    const params = new URLSearchParams(window.location.search);
    if (next === 'month') params.set('cal', 'month');
    else params.delete('cal');
    if (anchor === null) params.delete('abs');
    else params.set('abs', anchor);
    // Session memory: cosmetic preference, client-written (NOT httpOnly), no max-age ⇒ session-scoped.
    document.cookie = `leave_calendar_view=${next}; path=/; samesite=lax`;
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `/?${qs}` : '/');
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {win.from} &ndash; {win.to}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {/* Row 1: the My/Team scope switch. The slot is ALWAYS reserved at the shared h-7 control
              height so the header keeps the identical two-row structure for every role — an employee
              with no team simply gets an empty slot, never a reshaped layout. */}
          <div className="flex h-7 items-center justify-end">
            {showViewSwitch && <AbsenceViewSwitch view={effectiveView} onChange={changeView} />}
          </div>
          {/* Row 2: date navigation + Week/Month switch, one aligned h-7 family. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <TimelineNav
              from={displayFrom}
              isDefault={effectiveAnchor === null}
              mode={calView}
              onGo={goDate}
            />
            <CalendarRangeSwitch view={calView} onChange={changeCalView} />
          </div>
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
              days={win.days}
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
              // item 726ac8c2: only the TEAM view can hold someone else's row, so a stale ?focus= never
              // paints anything while the viewer is looking at their own leave.
              focusPersonId={effectiveView === 'team' ? focusPersonId : null}
            />
          </div>
          {legend}
        </>
      )}
    </>
  );
}
