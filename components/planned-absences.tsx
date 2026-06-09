import { Fragment } from 'react';
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

// Solid, semantic chips (no glass). Pending reads as an outlined/dashed variant of the
// same hue so status is legible without a second color.
const LEAVE_STYLE: Record<string, { solid: string; pending: string; swatch: string }> = {
  ANNUAL: {
    solid: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200',
    pending: 'border border-dashed border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/5 dark:text-violet-200',
    swatch: 'bg-violet-400',
  },
  SICK: {
    solid: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200',
    pending: 'border border-dashed border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/50 dark:bg-sky-500/5 dark:text-sky-200',
    swatch: 'bg-sky-400',
  },
  HOSPITALIZATION: {
    solid: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200',
    pending: 'border border-dashed border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-500/50 dark:bg-rose-500/5 dark:text-rose-200',
    swatch: 'bg-rose-400',
  },
  MATERNITY: {
    solid: 'bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200',
    pending: 'border border-dashed border-pink-400 bg-pink-50 text-pink-700 dark:border-pink-500/50 dark:bg-pink-500/5 dark:text-pink-200',
    swatch: 'bg-pink-400',
  },
  PATERNITY: {
    solid: 'bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200',
    pending: 'border border-dashed border-teal-400 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/5 dark:text-teal-200',
    swatch: 'bg-teal-400',
  },
  UNPAID: {
    solid: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
    pending: 'border border-dashed border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/50 dark:bg-amber-500/5 dark:text-amber-200',
    swatch: 'bg-amber-400',
  },
  _default: {
    solid: 'bg-slate-100 text-slate-800 dark:bg-slate-500/20 dark:text-slate-200',
    pending: 'border border-dashed border-slate-400 bg-slate-50 text-slate-700 dark:border-slate-500/50 dark:bg-slate-500/5 dark:text-slate-200',
    swatch: 'bg-slate-400',
  },
};
const styleFor = (code: string) => LEAVE_STYLE[code] ?? LEAVE_STYLE._default;

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

  const present = new Map<string, string>();
  for (const r of rows) for (const l of r.leaves) if (!present.has(l.typeCode)) present.set(l.typeCode, l.typeName);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Planned absences</h2>
          <p className="text-xs text-muted-foreground">
            {dayArr[0]?.iso} &ndash; {dayArr[lastIdx]?.iso}
          </p>
        </div>
        {present.size > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {[...present].map(([code, name]) => (
              <span key={code} className="inline-flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', styleFor(code).swatch)} />
                {name}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full border border-dashed border-muted-foreground" />
              pending
            </span>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">
          No employees in scope.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <div
            className="grid min-w-[680px] text-sm"
            style={{ gridTemplateColumns: `180px repeat(${days}, minmax(2rem, 1fr))` }}
          >
            {/* header */}
            <div className="sticky left-0 z-20 bg-card" style={{ gridColumn: 1, gridRow: 1 }} />
            {dayArr.map((d, i) => (
              <div
                key={d.iso}
                style={{ gridColumn: i + 2, gridRow: 1 }}
                className={cn('border-l border-border/60 px-1 py-2 text-center', d.isWeekend && 'bg-muted/40')}
              >
                <div
                  className={cn(
                    'text-[10px] uppercase',
                    d.iso === todayIso ? 'font-semibold text-primary' : 'text-muted-foreground',
                  )}
                >
                  {d.weekday}
                </div>
                <div className={cn('text-[13px] tabular-nums', d.iso === todayIso && 'font-semibold text-primary')}>
                  {d.dayNum}
                </div>
              </div>
            ))}

            {/* employee rows */}
            {rows.map((emp, r) => (
              <Fragment key={emp.id}>
                <div
                  className="sticky left-0 z-20 flex min-w-0 flex-col justify-center border-t border-border/60 bg-card px-3 py-2.5"
                  style={{ gridColumn: 1, gridRow: r + 2 }}
                >
                  <div className="truncate font-medium">{emp.name}</div>
                  {emp.role && <div className="truncate text-xs text-muted-foreground">{emp.role}</div>}
                </div>
                {dayArr.map((d, i) => (
                  <div
                    key={d.iso}
                    style={{ gridColumn: i + 2, gridRow: r + 2 }}
                    className={cn(
                      'min-h-[3rem] border-l border-t border-border/60',
                      d.isWeekend && 'bg-muted/30',
                      d.iso === todayIso && 'bg-primary/[0.04]',
                    )}
                  />
                ))}
                {emp.leaves.map((l) => {
                  const cs = Math.max(dayIndex(l.startDate, fromMs), 0);
                  const ce = Math.min(dayIndex(l.endDate, fromMs), lastIdx);
                  if (ce < 0 || cs > lastIdx) return null;
                  const st = styleFor(l.typeCode);
                  const pending = l.status === 'pending';
                  return (
                    <div
                      key={l.id}
                      style={{ gridColumn: `${cs + 2} / ${ce + 3}`, gridRow: r + 2 }}
                      className={cn(
                        'z-10 m-1 flex items-center self-center overflow-hidden rounded-lg px-2 py-1 text-xs font-medium',
                        pending ? st.pending : st.solid,
                      )}
                      title={`${l.typeName} · ${l.startDate} to ${l.endDate} · ${l.status}`}
                    >
                      <span className="truncate">{l.typeName}</span>
                    </div>
                  );
                })}
              </Fragment>
            ))}

            {/* today line */}
            {todayIdx >= 0 && todayIdx <= lastIdx && (
              <div
                aria-hidden
                className="pointer-events-none z-30 border-l-2 border-primary/70"
                style={{ gridColumn: todayIdx + 2, gridRow: `1 / ${rows.length + 2}` }}
              />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
