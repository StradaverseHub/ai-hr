import { Fragment } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Baby,
  CalendarDays,
  CircleSlash,
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
const LEAVE: Record<string, { chip: string; Icon: LucideIcon }> = {
  ANNUAL: { chip: 'bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100', Icon: Palmtree },
  SICK: { chip: 'bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-100', Icon: Thermometer },
  HOSPITALIZATION: { chip: 'bg-rose-100 text-rose-800 dark:bg-rose-500/25 dark:text-rose-100', Icon: Stethoscope },
  MATERNITY: { chip: 'bg-pink-100 text-pink-800 dark:bg-pink-500/25 dark:text-pink-100', Icon: Baby },
  PATERNITY: { chip: 'bg-teal-100 text-teal-800 dark:bg-teal-500/25 dark:text-teal-100', Icon: Baby },
  UNPAID: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/25 dark:text-amber-100', Icon: CircleSlash },
  _default: { chip: 'bg-slate-100 text-slate-800 dark:bg-slate-500/25 dark:text-slate-100', Icon: CalendarDays },
};
const styleFor = (code: string) => LEAVE[code] ?? LEAVE._default;

// Faint dotted texture for empty weekday cells (matches the reference's grid feel).
const DOTS = {
  backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
  backgroundSize: '8px 8px',
} as const;

export function PlannedAbsences({
  rows,
  from,
  days,
  todayIso,
}: {
  rows: Row[];
  from: string;
  days: number;
  todayIso: string;
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
        <Link
          href="/leave"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          View all
          <ArrowUpRight className="size-3.5" />
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">
          No employees in scope.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <div
            className="grid min-w-[760px] text-sm"
            style={{ gridTemplateColumns: `200px repeat(${days}, minmax(2.25rem, 1fr))` }}
          >
            {/* header */}
            <div className="sticky left-0 z-20 bg-card" style={{ gridColumn: 1, gridRow: 1 }} />
            {dayArr.map((d, i) => {
              const isToday = d.iso === todayIso;
              return (
                <div
                  key={d.iso}
                  style={{ gridColumn: i + 2, gridRow: 1 }}
                  className={cn('border-l border-border/60 px-1 py-2 text-center', d.isWeekend && 'bg-muted/40')}
                >
                  <div
                    className={cn(
                      'text-[10px] uppercase tracking-wide',
                      isToday ? 'font-semibold text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {d.weekday}
                  </div>
                  {isToday ? (
                    <div className="mx-auto mt-0.5 grid size-5 place-items-center rounded-full bg-primary text-[12px] font-semibold tabular-nums text-primary-foreground">
                      {d.dayNum}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[13px] tabular-nums">{d.dayNum}</div>
                  )}
                </div>
              );
            })}

            {/* employee rows */}
            {rows.map((emp, r) => (
              <Fragment key={emp.id}>
                <div
                  className="sticky left-0 z-20 flex min-w-0 items-center gap-2.5 border-t border-border/60 bg-card px-3 py-2.5"
                  style={{ gridColumn: 1, gridRow: r + 2 }}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {initials(emp.name)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-medium leading-tight">{emp.name}</div>
                    {emp.role && <div className="truncate text-xs text-muted-foreground">{emp.role}</div>}
                  </div>
                </div>
                {dayArr.map((d, i) => {
                  const isToday = d.iso === todayIso;
                  return (
                    <div
                      key={d.iso}
                      style={{ gridColumn: i + 2, gridRow: r + 2, ...(!d.isWeekend && !isToday ? DOTS : {}) }}
                      className={cn(
                        'min-h-[3.5rem] border-l border-t border-border/60',
                        !d.isWeekend && !isToday && 'text-border',
                        d.isWeekend && 'bg-muted/30',
                        isToday && 'bg-primary/[0.04]',
                      )}
                    />
                  );
                })}
                {emp.leaves.map((l) => {
                  const cs = Math.max(dayIndex(l.startDate, fromMs), 0);
                  const ce = Math.min(dayIndex(l.endDate, fromMs), lastIdx);
                  if (ce < 0 || cs > lastIdx) return null;
                  const { chip, Icon } = styleFor(l.typeCode);
                  const pending = l.status === 'pending';
                  return (
                    <div
                      key={l.id}
                      style={{ gridColumn: `${cs + 2} / ${ce + 3}`, gridRow: r + 2 }}
                      className={cn(
                        'z-10 m-1 flex items-center gap-1.5 self-center overflow-hidden rounded-full px-2.5 py-1.5 text-xs font-medium',
                        chip,
                        pending && 'ring-1 ring-inset ring-black/10 dark:ring-white/15',
                      )}
                      title={`${l.typeName} · ${l.startDate} to ${l.endDate} · ${l.status}`}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="flex-1 truncate">{l.typeName.replace(/\s*leave$/i, '')}</span>
                      <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 py-0.5 text-[10px] font-semibold capitalize dark:bg-white/15">
                        {l.status}
                      </span>
                    </div>
                  );
                })}
              </Fragment>
            ))}

            {/* today line (dashed) */}
            {todayIdx >= 0 && todayIdx <= lastIdx && (
              <div
                aria-hidden
                className="pointer-events-none z-30 border-l-2 border-dashed border-primary/60"
                style={{ gridColumn: todayIdx + 2, gridRow: `1 / ${rows.length + 2}` }}
              />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
