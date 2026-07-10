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
  // Leave Calendar Blocked View (c238010b): the hourly window (Postgres `time` strings, e.g. "09:00:00"),
  // shown in the pill's hover tooltip for hourly leave. Null for full/half-day rows.
  fromTime?: string | null;
  toTime?: string | null;
  // Partial Leave Cancellation from the calendar (ADR-0065): the eligibility shape + candidate dates the read
  // layer resolved, so the client grid can gate the same "Cancel dates" affordance the Leave page shows.
  parentGroupId?: string | null;
  isCancellationSplit?: boolean;
  pendingCancellationId?: string | null;
  candidateCancelDates?: string[];
};
type Row = { id: string; name: string; employeeCode?: string | null; role: string | null; leaves: Leave[] };

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MS_DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

// Solid, semantic chips (no glass), one per leave type, each with an icon.
// Exported so the Leave page's requests table speaks the same color language.
// Leave Calendar Blocked View (c238010b): `bg` / `text` are the split halves so the calendar's partial-day
// pills (left/right 50% fill, hourly outline) can reuse the same tokens; `chip` stays the combined string so
// `styleFor(...).chip` keeps working unchanged for the /leave requests-table chips.
const mk = (bg: string, text: string, Icon: LucideIcon) => ({ bg, text, chip: `${bg} ${text}`, Icon });
export const LEAVE: Record<string, { chip: string; bg: string; text: string; Icon: LucideIcon }> = {
  ANNUAL: mk('bg-violet-100 dark:bg-violet-500/30', 'text-violet-800 dark:text-violet-50', Palmtree),
  SICK: mk('bg-sky-100 dark:bg-sky-500/30', 'text-sky-800 dark:text-sky-50', Thermometer),
  HOSPITALIZATION: mk('bg-rose-100 dark:bg-rose-500/30', 'text-rose-800 dark:text-rose-50', Stethoscope),
  MATERNITY: mk('bg-pink-100 dark:bg-pink-500/30', 'text-pink-800 dark:text-pink-50', Baby),
  PATERNITY: mk('bg-teal-100 dark:bg-teal-500/30', 'text-teal-800 dark:text-teal-50', Baby),
  UNPAID: mk('bg-amber-100 dark:bg-amber-500/30', 'text-amber-800 dark:text-amber-50', CircleSlash),
  _default: mk('bg-slate-100 dark:bg-slate-500/30', 'text-slate-800 dark:text-slate-50', CalendarDays),
};
export const styleFor = (code: string) => LEAVE[code] ?? LEAVE._default;

// Leave Calendar Blocked View (c238010b): map the leave's duration_type to the calendar render variant —
// full-cell fill, left 50% (AM), right 50% (PM), or border-only outline (hourly).
export type DurationVariant = 'full' | 'am' | 'pm' | 'hourly';
const durationVariantOf = (durationType?: string | null): DurationVariant => {
  switch (durationType) {
    case 'half_day_am':
      return 'am';
    case 'half_day_pm':
      return 'pm';
    case 'hourly':
      return 'hourly';
    default:
      return 'full';
  }
};

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
  // Edit/cancel-by-status (item c9a19e34): the SAME cancelOwnLeaveAction the Leave page posts, for the viewer's
  // OWN PENDING leave (an immediate self-withdraw, no dates picker). Optional — absent ⇒ no affordance.
  selfCancelAction,
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
  selfCancelAction?: (fd: FormData) => void | Promise<void>;
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

  // Edit/cancel-by-status (item c9a19e34): the viewer may self-withdraw their OWN PENDING plain (non-EL/
  // non-REPLACEMENT) leave immediately from the calendar. Mirrors the Leave-page gate; the service re-asserts
  // subject-only + status='pending'. Approved own leave keeps the give-back affordance (cancelEligible above).
  const canOfferSelfCancel = !!selfCancelAction;
  const selfCancelEligible = (personId: string, l: Leave): boolean =>
    canOfferSelfCancel &&
    viewerPersonId != null &&
    personId === viewerPersonId &&
    l.status === 'pending' &&
    l.parentGroupId == null &&
    l.typeCode !== 'EMERGENCY' &&
    l.typeCode !== 'REPLACEMENT';

  // Translate per-pill titles + status labels server-side so the client grid stays i18n-free.
  const gridRows: GridRow[] = rows.map((emp) => ({
    id: emp.id,
    name: emp.name,
    employeeCode: emp.employeeCode ?? null,
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
      durationVariant: durationVariantOf(l.durationType),
      // Leave Calendar Blocked View (c238010b): an hourly pill's hover tooltip shows its exact window; every
      // other row keeps the date-span title. Times are Postgres `time` strings — trim to HH:MM (house style).
      title:
        l.durationType === 'hourly' && l.fromTime && l.toTime
          ? t('pillTitleHourly', {
              type: l.typeName,
              start: l.startDate,
              from: l.fromTime.slice(0, 5),
              to: l.toTime.slice(0, 5),
              status: l.status,
            })
          : t('pillTitle', { type: l.typeName, start: l.startDate, end: l.endDate, status: l.status }),
      // Cancel affordance: only the fields the client grid needs to render CancelDatesDialog for THIS pill.
      cancelEligible: cancelEligible(emp.id, l),
      candidateCancelDates: cancelEligible(emp.id, l) ? (l.candidateCancelDates ?? []) : [],
      // HR Admin Leave Cancellation (feedback 22e68ff0): whether an HR admin can immediately cancel THIS pill.
      adminCancelEligible: adminCancelEligible(emp.id, l),
      // Edit/cancel-by-status (item c9a19e34): whether the viewer can self-withdraw THIS pending own pill.
      selfCancelEligible: selfCancelEligible(emp.id, l),
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
          selfCancelAction={selfCancelAction}
          selfCancelPillLabel={tLeave('selfCancelPillAffordanceLabel')}
        />
      )}

      {/* Leave Calendar Blocked View (c238010b): legend explaining the four duration render patterns. Labels
          reuse leave.duration.* so the naming stays in lockstep with the Request-leave dropdown (c1e8d881). */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-sm bg-foreground/20" />
            {tLeave('duration.full_day')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="relative size-3 overflow-hidden rounded-sm ring-1 ring-inset ring-foreground/30"
            >
              <span className="absolute inset-y-0 left-0 w-1/2 bg-foreground/40" />
            </span>
            {tLeave('duration.half_day_am')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="relative size-3 overflow-hidden rounded-sm ring-1 ring-inset ring-foreground/30"
            >
              <span className="absolute inset-y-0 right-0 w-1/2 bg-foreground/40" />
            </span>
            {tLeave('duration.half_day_pm')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-sm ring-1 ring-inset ring-foreground/40" />
            {tLeave('duration.hourly')}
          </span>
        </div>
      )}
    </Card>
  );
}
