'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CheckCircle2, ChevronDown, Clock, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CALENDAR_FOCUS_MS } from '@/lib/calendar-focus';
import { styleFor } from '@/components/planned-absences';
import { CancelDatesDialog } from '@/components/leave/cancel-dates-dialog';
import { EmployeeName } from '@/components/ui';
import { AdminCancelLeaveDialog } from '@/components/leave/admin-cancel-leave-dialog';
import { CancelLeaveDialog } from '@/components/leave/cancel-leave-dialog';

const MS_DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const dayIndex = (iso: string, fromMs: number) => Math.round((ms(iso) - fromMs) / MS_DAY);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

// Faint diagonal hatch for empty cells (currentColor = the cell's faint text color).
const HATCH = {
  backgroundImage:
    'repeating-linear-gradient(45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 7px)',
} as const;
// Soft shadow so leave pills float above the tile grid.
const FLOAT = { boxShadow: '0 1px 2px rgb(20 20 45 / 0.10), 0 4px 10px -2px rgb(20 20 45 / 0.14)' } as const;

export type GridLeave = {
  id: string;
  typeCode: string;
  typeName: string;
  status: string; // 'approved' | 'pending'
  statusLabel: string;
  startDate: string;
  endDate: string;
  title: string;
  /** ADR-0048: short badge for non-full-day leave ("½ AM" / "2h"); null for full-day. */
  durationBadge?: string | null;
  /** Leave Calendar Blocked View (c238010b): how to fill the cell — full solid, left 50% (AM), right 50%
   *  (PM), or border-only outline (hourly). Defaults to 'full' when absent. */
  durationVariant?: 'full' | 'am' | 'pm' | 'hourly';
  /** ADR-0065 (calendar cancel entry point): true when the viewer can give back dates on THIS pill. Gated
   *  server-side (own + approved + full_day + plain/split + no-pending + ≥1 candidate). */
  cancelEligible?: boolean;
  /** ADR-0065: the exact cancellable working dates (strictly-after-today, holiday-aware) for this pill's
   *  underlying leave request — seeded into the reused CancelDatesDialog checkboxes. */
  candidateCancelDates?: string[];
  /** feedback 22e68ff0: true when the viewer is an HR admin who may immediately cancel THIS pill's leave on
   *  behalf of the employee (gated server-side: admin + not own + pending|approved + not approved-REPLACEMENT). */
  adminCancelEligible?: boolean;
  /** item c9a19e34: true when the viewer may self-withdraw THIS pending own pill (gated server-side:
   *  own + pending + plain + non-EL/REPLACEMENT). */
  selfCancelEligible?: boolean;
  /** 8cb7b089: hash deep-link into the matching /approvals section for a pill awaiting the viewer's
   *  decision (built server-side from APPROVAL_SECTION_ID); null ⇒ no arrow renders. */
  approvalHref?: string | null;
};
export type GridRow = { id: string; name: string; employeeCode?: string | null; role: string | null; leaves: GridLeave[] };
export type GridDay = { iso: string; weekday: string; dayNum: number; isWeekend: boolean };

/** Default number of employee rows shown before the "show all" affordance kicks in. */
const COLLAPSED_ROWS = 6;

/**
 * Client half of PlannedAbsences: renders the bubble-tile grid + floating leave pills, and
 * caps the row count so a long roster doesn't run off the card. When more rows exist than the
 * collapsed cap, an expand toggle reveals the rest (and collapses back). Strings + per-pill
 * titles are translated server-side and passed in, so this stays i18n-clean.
 */
export function PlannedAbsencesGrid({
  rows,
  dayArr,
  days,
  fromMs,
  todayIso,
  employeesLabel,
  showAllLabel,
  showLessLabel,
  // ADR-0065 (calendar cancel entry point): the SAME server action the Leave page posts. Optional — when
  // absent the grid is read-only and no cancel affordance renders on any pill.
  cancelAction,
  cancelPillLabel,
  // feedback 22e68ff0: the SAME on-behalf HR-cancel action the Leave page posts. Optional — absent ⇒ no admin
  // affordance renders on any pill.
  adminCancelAction,
  adminCancelPillLabel,
  // item c9a19e34: the SAME cancelOwnLeaveAction the Leave page posts, for the viewer's own PENDING pill.
  selfCancelAction,
  selfCancelPillLabel,
  // 8cb7b089: aria-label for the per-pill "go to approval" deep-link arrow.
  approvalPillLabel,
  // item 726ac8c2: the person id the Leave Summary's "View Calendar" action asked us to highlight.
  focusPersonId,
}: {
  rows: GridRow[];
  dayArr: GridDay[];
  days: number;
  fromMs: number;
  todayIso: string;
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
  // item 726ac8c2 — arrival highlight. Driven by React state rather than the approvals arrival island's
  // DOM stamping, because the target row may not be in the DOM at all: the roster collapses to
  // COLLAPSED_ROWS and a deep-linked employee further down would otherwise be a silent miss. Knowing the
  // index lets us open the roster first and highlight second.
  const focusIdx = focusPersonId ? rows.findIndex((r) => r.id === focusPersonId) : -1;
  const [showAll, setShowAll] = useState(focusIdx >= COLLAPSED_ROWS);
  // Held for the requested 3s and then dropped, so the highlight reads as an arrival cue rather than a
  // permanent selection. A focus id that matches no row (wrong team, or a person with no calendar row)
  // starts inactive — arrival degrades to a plain calendar, never an error.
  const [focusActive, setFocusActive] = useState(focusIdx >= 0);
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusActive) return;
    // The card itself is reached by the href's #planned-absences anchor; this brings the ROW into view
    // inside the roster. Honoured explicitly for reduced motion — the global CSS reset cannot suppress
    // a JS smooth-scroll option (same reasoning as app/approvals/attention-on-arrival.tsx).
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    focusRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    const timer = window.setTimeout(() => setFocusActive(false), CALENDAR_FOCUS_MS);
    return () => window.clearTimeout(timer);
  }, [focusActive]);
  const lastIdx = days - 1;
  const todayIdx = dayIndex(todayIso, fromMs);
  const canExpand = rows.length > COLLAPSED_ROWS;
  const visibleRows = showAll || !canExpand ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <>
      <div className="overflow-x-auto border-t border-border px-3 pb-3 pt-1">
        <div
          className="grid min-w-[820px] gap-1.5 text-sm"
          style={{ gridTemplateColumns: `188px repeat(${days}, minmax(2.5rem, 1fr))` }}
        >
          {/* header */}
          <div className="sticky left-0 z-20 bg-card" style={{ gridColumn: 1, gridRow: 1 }}>
            <span className="text-xs font-medium text-muted-foreground">{employeesLabel}</span>
          </div>
          {dayArr.map((d, i) => {
            const isToday = d.iso === todayIso;
            return (
              <div
                key={d.iso}
                style={{ gridColumn: i + 2, gridRow: 1 }}
                className={cn(
                  'flex flex-col items-center rounded-lg px-1 py-1.5 text-center',
                  isToday
                    ? 'bg-primary text-primary-foreground'
                    : d.isWeekend
                      ? 'bg-muted/60 text-muted-foreground'
                      : 'text-muted-foreground',
                )}
              >
                <span className="text-[10px] uppercase tracking-wide">{d.weekday}</span>
                <span className="text-[13px] font-semibold tabular-nums">{d.dayNum}</span>
              </div>
            );
          })}

          {/* employee rows */}
          {visibleRows.map((emp, r) => (
            <Fragment key={emp.id}>
              <div
                // item 726ac8c2: the deep-linked employee. The ref is bound by IDENTITY (so the scroll
                // still lands after the 3s highlight has expired); the class is bound by `focusActive`,
                // the window that actually paints it.
                ref={emp.id === focusPersonId ? focusRef : undefined}
                className={cn(
                  'sticky left-0 z-20 flex min-w-0 items-center gap-2.5 bg-card pr-2',
                  focusActive && emp.id === focusPersonId && 'calendar-focus-attention',
                )}
                style={{ gridColumn: 1, gridRow: r + 2 }}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                  {initials(emp.name)}
                </span>
                <div className="min-w-0">
                  {/* 546db76e: no Employee ID on the calendar's name column — EmployeeName without `code`
                      renders the name alone (EmployeeCode's null-render contract), byte-identical box. */}
                  <EmployeeName name={emp.name} className="truncate text-[13px] font-medium leading-tight" />
                  {emp.role && <div className="truncate text-xs text-muted-foreground">{emp.role}</div>}
                </div>
              </div>
              {/* standalone bubble tiles */}
              {dayArr.map((d, i) => {
                const isToday = d.iso === todayIso;
                return (
                  <div
                    key={d.iso}
                    style={{ gridColumn: i + 2, gridRow: r + 2, ...HATCH }}
                    className={cn(
                      'min-h-[2.75rem] rounded-lg text-border',
                      d.isWeekend ? 'bg-muted/50' : 'bg-muted/25',
                      isToday && 'bg-primary/[0.06] text-primary/20',
                      // item 726ac8c2: a STATIC ring carries the highlight across the focused row's day
                      // tiles. Deliberately not animated — shaking the whole row would jitter the pills
                      // out of alignment with the day columns they sit under.
                      focusActive && emp.id === focusPersonId && 'ring-1 ring-inset ring-ring/50',
                    )}
                  />
                );
              })}
              {/* floating leave pills */}
              {emp.leaves.map((l) => {
                const cs = Math.max(dayIndex(l.startDate, fromMs), 0);
                const ce = Math.min(dayIndex(l.endDate, fromMs), lastIdx);
                if (ce < 0 || cs > lastIdx) return null;
                const { chip, bg, text, Icon } = styleFor(l.typeCode);
                const pending = l.status === 'pending';
                const span = ce - cs + 1;
                const StatusIcon = pending ? Clock : CheckCircle2;
                // Leave Calendar Blocked View (c238010b): the fill pattern for this pill.
                //  full   → solid chip across the whole cell (unchanged).
                //  am/pm  → transparent pill with a colored 50% fill layer pinned left/right + a colored outline.
                //  hourly → border-only: no fill, a thicker colored outline (reporter's "colored border" style).
                // The half-fill sits under the icon/label/badge via `isolate` + a `-z-10` layer, so no per-child
                // z-index is needed and content stays legible on the unfilled half.
                const variant = l.durationVariant ?? 'full';
                const isFull = variant === 'full';
                // ADR-0065 (calendar cancel entry point): render the reused CancelDatesDialog on an eligible
                // pill, triggered by a compact XCircle icon-button appended inside the pill. Gated + candidate
                // dates resolved server-side; the dialog + action are the SAME ones the Leave page uses.
                const showCancel = !!cancelAction && !!l.cancelEligible;
                // feedback 22e68ff0: an HR admin can immediately cancel this pill on the employee's behalf. Same
                // compact XCircle trigger convention as the employee give-back, but opens AdminCancelLeaveDialog
                // (confirmation + optional reason) and posts the on-behalf action with the calendar's own page as
                // the return surface (a00c4f64 moved that from the dashboard to /leave/tracker).
                const showAdminCancel = !!adminCancelAction && !!l.adminCancelEligible;
                // item c9a19e34: the viewer self-withdraws their own PENDING pill (immediate, no dates picker).
                const showSelfCancel = !!selfCancelAction && !!l.selfCancelEligible;
                return (
                  <div
                    // 8cb7b089 (6c): a per-date-approval request expands to one pill PER contiguous approved
                    // run, all sharing l.id — key by id+startDate so siblings can't collide now that the pill
                    // hosts a focusable link (an unstable key could move focus unpredictably).
                    key={`${l.id}-${l.startDate}`}
                    style={{
                      gridColumn: `${cs + 2} / ${ce + 3}`,
                      gridRow: r + 2,
                      ...FLOAT,
                    }}
                    className={cn(
                      'relative isolate z-10 my-1 flex items-center gap-1.5 self-stretch overflow-hidden rounded-full px-2.5 text-xs font-medium',
                      isFull && chip,
                      // Pending's extra ring only on solid full-day pills — partial variants already carry a
                      // colored outline, so stacking a second ring there would read muddy.
                      isFull && pending && 'ring-1 ring-inset ring-black/10 dark:ring-white/15',
                      (variant === 'am' || variant === 'pm') &&
                        cn(text, 'bg-transparent ring-1 ring-inset ring-current/40'),
                      variant === 'hourly' && cn(text, 'bg-transparent ring-2 ring-inset ring-current/60'),
                    )}
                    title={l.title}
                  >
                    {variant === 'am' && (
                      <span aria-hidden className={cn('absolute inset-y-0 left-0 -z-10 w-1/2 rounded-l-full', bg)} />
                    )}
                    {variant === 'pm' && (
                      <span
                        aria-hidden
                        className={cn('absolute inset-y-0 right-0 -z-10 w-1/2 rounded-r-full', bg)}
                      />
                    )}
                    <Icon className="size-3.5 shrink-0" />
                    <span className="flex-1 truncate">{l.typeName.replace(/\s*leave$/i, '')}</span>
                    {l.durationBadge && (
                      <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 py-0.5 text-[10px] font-semibold dark:bg-white/15">
                        {l.durationBadge}
                      </span>
                    )}
                    {isFull &&
                      (span >= 4 ? (
                        <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 py-0.5 text-[10px] font-semibold capitalize dark:bg-white/15">
                          {l.statusLabel}
                        </span>
                      ) : span >= 3 ? (
                        <StatusIcon className="size-3.5 shrink-0 opacity-80" />
                      ) : null)}
                    {showCancel && (
                      <CancelDatesDialog
                        leaveRequestId={l.id}
                        candidateDates={l.candidateCancelDates ?? []}
                        submitAction={cancelAction!}
                        trigger={
                          <button
                            type="button"
                            aria-label={cancelPillLabel}
                            title={cancelPillLabel}
                            className="relative z-10 grid size-4 shrink-0 place-items-center rounded-full text-current/70 transition-opacity hover:text-current hover:opacity-100"
                          >
                            <XCircle className="size-3.5" />
                          </button>
                        }
                      />
                    )}
                    {showAdminCancel && (
                      <AdminCancelLeaveDialog
                        leaveRequestId={l.id}
                        back="/leave/tracker"
                        submitAction={adminCancelAction!}
                        trigger={
                          <button
                            type="button"
                            aria-label={adminCancelPillLabel}
                            title={adminCancelPillLabel}
                            className="relative z-10 grid size-4 shrink-0 place-items-center rounded-full text-current/70 transition-opacity hover:text-current hover:opacity-100"
                          >
                            <XCircle className="size-3.5" />
                          </button>
                        }
                      />
                    )}
                    {showSelfCancel && (
                      <CancelLeaveDialog
                        leaveRequestId={l.id}
                        submitAction={selfCancelAction!}
                        trigger={
                          <button
                            type="button"
                            aria-label={selfCancelPillLabel}
                            title={selfCancelPillLabel}
                            className="relative z-10 grid size-4 shrink-0 place-items-center rounded-full text-current/70 transition-opacity hover:text-current hover:opacity-100"
                          >
                            <XCircle className="size-3.5" />
                          </button>
                        }
                      />
                    )}
                    {/* 8cb7b089: deep-link arrow to the matching /approvals section for a pill awaiting the
                        viewer's decision. scroll=false: the arrival island owns scrolling. prefetch=false: the
                        Approvals page is heavy — don't pay for it from the dashboard. NO title attr: the
                        wrapping div's title (hourly window, c238010b) must keep winning.
                        a34eedde: the link's ::after overlay STRETCHES over the whole pill (nearest positioned
                        ancestor = the `relative` pill div), so clicking anywhere on the pill body navigates as
                        a real anchor — modifier/middle clicks, defaultPrevented, and drag all behave natively,
                        and the portaled cancel dialogs (React SIBLINGS of this link) can never bubble into it.
                        The hover ring must be INSET (overflow-hidden would clip an outset ring); ring-current
                        picks up each variant's own text color. The dialog triggers above carry `relative z-10`
                        so they paint over the overlay and keep their clicks. */}
                    {l.approvalHref && (
                      <Link
                        href={l.approvalHref}
                        prefetch={false}
                        scroll={false}
                        aria-label={approvalPillLabel}
                        className="grid size-4 shrink-0 place-items-center rounded-full text-current/70 transition-opacity after:absolute after:inset-0 after:rounded-full after:ring-inset after:transition-shadow hover:text-current hover:opacity-100 hover:after:ring-2 hover:after:ring-current/50"
                      >
                        <ArrowUpRight className="size-3.5" />
                      </Link>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}

          {/* today line (dashed), floating over the tiles */}
          {todayIdx >= 0 && todayIdx <= lastIdx && (
            <div
              aria-hidden
              className="pointer-events-none z-30 -ml-1 border-l-2 border-dashed border-primary/50"
              style={{ gridColumn: todayIdx + 2, gridRow: `2 / ${visibleRows.length + 2}` }}
            />
          )}
        </div>
      </div>

      {canExpand && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="flex w-full items-center justify-center gap-1.5 border-t border-border px-5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {showAll ? showLessLabel : showAllLabel}
          <ChevronDown className={cn('size-3.5 transition-transform duration-200', showAll && 'rotate-180')} />
        </button>
      )}
    </>
  );
}
