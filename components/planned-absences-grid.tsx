'use client';

import { Fragment, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { styleFor } from '@/components/planned-absences';
import { CancelDatesDialog } from '@/components/leave/cancel-dates-dialog';
import { EmployeeName } from '@/components/ui';

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
}) {
  const [showAll, setShowAll] = useState(false);
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
                className="sticky left-0 z-20 flex min-w-0 items-center gap-2.5 bg-card pr-2"
                style={{ gridColumn: 1, gridRow: r + 2 }}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                  {initials(emp.name)}
                </span>
                <div className="min-w-0">
                  {/* Employee ID left-of-name (feedback 38668d9b) */}
                  <EmployeeName code={emp.employeeCode} name={emp.name} className="truncate text-[13px] font-medium leading-tight" />
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
                return (
                  <div
                    key={l.id}
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
                            className="grid size-4 shrink-0 place-items-center rounded-full text-current/70 transition-opacity hover:text-current hover:opacity-100"
                          >
                            <XCircle className="size-3.5" />
                          </button>
                        }
                      />
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
