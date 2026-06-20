import { type ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
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
import { PlannedAbsencesGrid, type GridRow } from '@/components/planned-absences-grid';

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

export async function PlannedAbsences({
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
  const t = await getTranslations('components.plannedAbsences');
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
  const lastIdx = days - 1;

  // Translate per-pill titles + status labels server-side so the client grid stays i18n-free.
  const gridRows: GridRow[] = rows.map((emp) => ({
    id: emp.id,
    name: emp.name,
    role: emp.role,
    leaves: emp.leaves.map((l) => ({
      id: l.id,
      typeCode: l.typeCode,
      typeName: l.typeName,
      status: l.status,
      startDate: l.startDate,
      endDate: l.endDate,
      statusLabel: l.status,
      title: t('pillTitle', { type: l.typeName, start: l.startDate, end: l.endDate, status: l.status }),
    })),
  }));

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t('title')}</h2>
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
            {t('viewAll')}
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <PlannedAbsencesGrid
          rows={gridRows}
          dayArr={dayArr}
          days={days}
          fromMs={fromMs}
          todayIso={todayIso}
          employeesLabel={t('employees')}
          showAllLabel={t('showAll', { count: rows.length })}
          showLessLabel={t('showLess')}
        />
      )}
    </Card>
  );
}
