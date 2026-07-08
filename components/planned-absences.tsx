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
  employmentId: string; // ADR-0065: per-row employment so eligibility can't collide across concurrent jobs
  typeCode: string;
  typeName: string;
  status: string; // 'approved' | 'pending'
  startDate: string;
  endDate: string;
  durationType?: string | null; // ADR-0048
  hours?: string | number | null; // ADR-0048
  // Partial Leave Cancellation from the calendar (ADR-0065): the eligibility shape + candidate dates the read
  // layer resolved, so the client grid can gate the same "Cancel dates" affordance the Leave page shows.
  parentGroupId?: string | null;
  isCancellationSplit?: boolean;
  pendingCancellationId?: string | null;
  candidateCancelDates?: string[];
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
  // Partial Leave Cancellation from the calendar (ADR-0065): the viewer's personId gates the "own leave only"
  // rule, and cancelAction is the SAME server action the Leave page posts (requestLeaveCancellationAction).
  // Both optional — when either is absent the calendar simply renders no cancel affordance (read-only mode).
  viewerPersonId,
  cancelAction,
  // HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0): when the viewer is an HR admin,
  // adminCancelAction is the SAME action the Leave page posts. Both optional — absent ⇒ no admin affordance.
  viewerIsAdmin,
  adminCancelAction,
}: {
  rows: Row[];
  from: string;
  days: number;
  todayIso: string;
  controls?: ReactNode;
  viewerPersonId?: string | null;
  cancelAction?: (fd: FormData) => void | Promise<void>;
  viewerIsAdmin?: boolean;
  adminCancelAction?: (fd: FormData) => void | Promise<void>;
}) {
  const t = await getTranslations('components.plannedAbsences');
  const tLeave = await getTranslations('leave');
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

  // ADR-0048: a short duration badge for non-full-day leave ("½ AM", "½ PM", "2h"). Translated/formatted
  // server-side so the client grid stays i18n-free; null for full-day leave (no badge, full-width tile).
  const durationBadge = (durationType?: string | null, hours?: string | number | null): string | null => {
    switch (durationType) {
      case 'half_day_am':
        return t('durationBadgeHalfAm');
      case 'half_day_pm':
        return t('durationBadgeHalfPm');
      case 'hourly': {
        const h = hours == null ? null : Number(hours);
        return h != null && Number.isFinite(h) ? t('durationBadgeHours', { hours: h }) : null;
      }
      default:
        return null;
    }
  };

  // Partial Leave Cancellation from the calendar (ADR-0065): a pill is cancellable when the viewer is the
  // subject (own leave — emp.id is the personId), the row is approved + full_day, it is a plain request OR a
  // cancellation-split survivor (parentGroupId null OR isCancellationSplit), no cancellation is already pending
  // on it, and the read layer resolved ≥1 candidate date. This mirrors the Leave page gate (app/leave/page.tsx
  // :264-269) exactly so a date never looks cancellable here but is rejected on submit (or vice-versa).
  const canOfferCancel = !!cancelAction;
  const cancelEligible = (personId: string, l: Leave): boolean =>
    canOfferCancel &&
    viewerPersonId != null &&
    personId === viewerPersonId &&
    l.status === 'approved' &&
    l.durationType === 'full_day' &&
    (l.parentGroupId == null || !!l.isCancellationSplit) &&
    !l.pendingCancellationId &&
    (l.candidateCancelDates?.length ?? 0) > 0;

  // HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0): an HR admin may cancel ANOTHER
  // employee's pending/approved leave immediately from the calendar. Mirrors the Leave-page gate (page.tsx):
  // admin viewer, not the viewer's OWN person (self-ban — own leave uses the give-back flow), pending|approved,
  // and NOT an approved REPLACEMENT (no TOIL-register inverse). The service re-validates authoritatively.
  const canOfferAdminCancel = !!adminCancelAction && !!viewerIsAdmin;
  const adminCancelEligible = (personId: string, l: Leave): boolean =>
    canOfferAdminCancel &&
    (viewerPersonId == null || personId !== viewerPersonId) &&
    (l.status === 'pending' || l.status === 'approved') &&
    !(l.status === 'approved' && l.typeCode === 'REPLACEMENT');

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
      durationBadge: durationBadge(l.durationType, l.hours),
      partial: l.durationType != null && l.durationType !== 'full_day',
      title: t('pillTitle', { type: l.typeName, start: l.startDate, end: l.endDate, status: l.status }),
      // Cancel affordance: only the fields the client grid needs to render CancelDatesDialog for THIS pill.
      cancelEligible: cancelEligible(emp.id, l),
      candidateCancelDates: cancelEligible(emp.id, l) ? (l.candidateCancelDates ?? []) : [],
      // HR Admin Leave Cancellation (feedback 22e68ff0): whether an HR admin can immediately cancel THIS pill.
      adminCancelEligible: adminCancelEligible(emp.id, l),
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
          cancelAction={cancelAction}
          cancelPillLabel={tLeave('cancelPillAffordanceLabel')}
          adminCancelAction={adminCancelAction}
          adminCancelPillLabel={tLeave('adminCancelPillAffordanceLabel')}
        />
      )}
    </Card>
  );
}
