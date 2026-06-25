'use client';

import { Fragment, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { styleFor } from '@/components/planned-absences';

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
  /** ADR-0048: true for half/hourly leave — drawn as a partial (half-height, hatched) pill. */
  partial?: boolean;
};
export type GridRow = { id: string; name: string; role: string | null; leaves: GridLeave[] };
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
}: {
  rows: GridRow[];
  dayArr: GridDay[];
  days: number;
  fromMs: number;
  todayIso: string;
  employeesLabel: string;
  showAllLabel: string;
  showLessLabel: string;
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
                  <div className="truncate text-[13px] font-medium leading-tight">{emp.name}</div>
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
                const { chip, Icon } = styleFor(l.typeCode);
                const pending = l.status === 'pending';
                const span = ce - cs + 1;
                const StatusIcon = pending ? Clock : CheckCircle2;
                // ADR-0048: a half/hourly leave covers only part of the day — draw it as a partial pill
                // (shorter, hatched overlay, duration badge) so it never reads as a full day on the grid.
                const partial = !!l.partial;
                return (
                  <div
                    key={l.id}
                    style={{
                      gridColumn: `${cs + 2} / ${ce + 3}`,
                      gridRow: r + 2,
                      ...FLOAT,
                      ...(partial ? HATCH : {}),
                    }}
                    className={cn(
                      'z-10 flex items-center gap-1.5 self-stretch overflow-hidden rounded-full px-2.5 text-xs font-medium',
                      chip,
                      pending && 'ring-1 ring-inset ring-black/10 dark:ring-white/15',
                      // Partial pill: inset top/bottom so it visibly occupies less than a full tile.
                      partial ? 'my-2' : 'my-1',
                    )}
                    title={l.title}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="flex-1 truncate">{l.typeName.replace(/\s*leave$/i, '')}</span>
                    {l.durationBadge && (
                      <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 py-0.5 text-[10px] font-semibold dark:bg-white/15">
                        {l.durationBadge}
                      </span>
                    )}
                    {!partial &&
                      (span >= 4 ? (
                        <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 py-0.5 text-[10px] font-semibold capitalize dark:bg-white/15">
                          {l.statusLabel}
                        </span>
                      ) : span >= 3 ? (
                        <StatusIcon className="size-3.5 shrink-0 opacity-80" />
                      ) : null)}
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
