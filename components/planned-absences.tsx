import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Baby,
  CalendarDays,
  CheckCircle2,
  CircleSlash,
  Clock,
  Palmtree,
  Stethoscope,
  Thermometer,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';

type Leave = {
  id: string;
  typeCode: string;
  typeName: string;
  status: string; // 'approved' | 'pending'
  startDate: string;
  endDate: string;
};
type Row = { id: string; name: string; role: string | null; leaves: Leave[] };

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MS_DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const dayIndex = (iso: string, fromMs: number) => Math.round((ms(iso) - fromMs) / MS_DAY);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

// Solid, semantic chips (no glass), one per leave type, each with an icon.
// Exported so the Leave page's requests table speaks the same color language.
export const LEAVE: Record<string, { chip: string; Icon: LucideIcon }> = {
  ANNUAL: { chip: 'bg-violet-100 text-violet-800 dark:bg-violet-500/30 dark:text-violet-50', Icon: Palmtree },
  SICK: { chip: 'bg-sky-100 text-sky-800 dark:bg-sky-500/30 dark:text-sky-50', Icon: Thermometer },
  HOSPITALIZATION: { chip: 'bg-rose-100 text-rose-800 dark:bg-rose-500/30 dark:text-rose-50', Icon: Stethoscope },
  MATERNITY: { chip: 'bg-pink-100 text-pink-800 dark:bg-pink-500/30 dark:text-pink-50', Icon: Baby },
  PATERNITY: { chip: 'bg-teal-100 text-teal-800 dark:bg-teal-500/30 dark:text-teal-50', Icon: Baby },
  UNPAID: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/30 dark:text-amber-50', Icon: CircleSlash },
  _default: { chip: 'bg-slate-100 text-slate-800 dark:bg-slate-500/30 dark:text-slate-50', Icon: CalendarDays },
};
export const styleFor = (code: string) => LEAVE[code] ?? LEAVE._default;

// Faint diagonal hatch for empty cells (currentColor = the cell's faint text color).
const HATCH = {
  backgroundImage:
    'repeating-linear-gradient(45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 7px)',
} as const;
// Soft shadow so leave pills float above the tile grid.
const FLOAT = { boxShadow: '0 1px 2px rgb(20 20 45 / 0.10), 0 4px 10px -2px rgb(20 20 45 / 0.14)' } as const;

export function PlannedAbsences({
  rows,
  from,
  days,
  todayIso,
  controls,
}: {
  rows: Row[];
  from: string;
  days: number;
  todayIso: string;
  controls?: ReactNode;
}) {
  const fromMs = ms(from);
  const dayArr = Array.from({ length: days }, (_, i) => {
    const d = new Date(fromMs + i * MS_DAY);
    const dow = d.getUTCDay();
    return {
      iso: d.toISOString().slice(0, 10),
      weekday: WEEKDAY[dow],
      dayNum: d.getUTCDate(),
      isWeekend: dow === 0 || dow === 6,
    };
  });
  const todayIdx = dayIndex(todayIso, fromMs);
  const lastIdx = days - 1;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Planned absences</h2>
          <p className="text-xs text-muted-foreground">
            {dayArr[0]?.iso} &ndash; {dayArr[lastIdx]?.iso}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {controls}
          <Link
            href="/leave"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            View all
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">
          No employees in scope.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-border px-3 pb-3 pt-1">
          <div
            className="grid min-w-[820px] gap-1.5 text-sm"
            style={{ gridTemplateColumns: `188px repeat(${days}, minmax(2.5rem, 1fr))` }}
          >
            {/* header */}
            <div className="sticky left-0 z-20 bg-card" style={{ gridColumn: 1, gridRow: 1 }}>
              <span className="text-xs font-medium text-muted-foreground">Employees</span>
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
            {rows.map((emp, r) => (
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
                  return (
                    <div
                      key={l.id}
                      style={{ gridColumn: `${cs + 2} / ${ce + 3}`, gridRow: r + 2, ...FLOAT }}
                      className={cn(
                        'z-10 my-1 flex items-center gap-1.5 self-stretch overflow-hidden rounded-full px-2.5 text-xs font-medium',
                        chip,
                        pending && 'ring-1 ring-inset ring-black/10 dark:ring-white/15',
                      )}
                      title={`${l.typeName} · ${l.startDate} to ${l.endDate} · ${l.status}`}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="flex-1 truncate">{l.typeName.replace(/\s*leave$/i, '')}</span>
                      {span >= 4 ? (
                        <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 py-0.5 text-[10px] font-semibold capitalize dark:bg-white/15">
                          {l.status}
                        </span>
                      ) : span >= 3 ? (
                        <StatusIcon className="size-3.5 shrink-0 opacity-80" />
                      ) : null}
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
                style={{ gridColumn: todayIdx + 2, gridRow: `2 / ${rows.length + 2}` }}
              />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
