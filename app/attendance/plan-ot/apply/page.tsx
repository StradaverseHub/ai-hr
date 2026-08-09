import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { dayTypeFor, otMonthToDateMinutes } from '@/packs/attendance/service';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myRequestOvertime } from '@/app/me/actions';
import { PlanOtFields } from './plan-ot-fields';

/**
 * My Attendance > Plan OT > Apply OT Plan (1e9145d4).
 *
 * LIFTED FROM the Overtime Request card on /attendance/requests, not rebuilt: the same server action
 * (myRequestOvertime), the same core service (requestAttendanceCorrection), the same approval route. What
 * it gains is the planned start/end window with the hours worked out as you type, a reason category, and
 * two warnings that WARN AND DO NOT BLOCK.
 *
 * IT OPENS ON TOMORROW. The card it replaces opened on YESTERDAY, which is the wrong end of the problem for
 * a screen whose purpose is agreeing overtime before it is worked. A PAST DATE IS STILL ACCEPTED and behaves
 * exactly as it does today — claiming overtime after the fact is the path that already works, and this
 * screen is now its only home, so taking it away would be a regression dressed as a feature.
 *
 * THE TWO WARNINGS, and why they are split across the server and the client:
 *   • The KIND OF DAY (ordinary / rest day / public holiday) can only be answered by scheduleFor, over the
 *     roster and the ADR-0055 holiday calendar. It is resolved HERE, on the server, for the date in the
 *     address bar — the client island soft-navigates when the date changes so this panel keeps up.
 *   • The MONTHLY CEILING has to react to the hours as they are typed, so the island does that arithmetic
 *     against the month-to-date figure resolved here (which already counts approved plans that have not
 *     landed yet — otherwise it would tell you there is room you have already committed).
 *
 * NEITHER STOPS A SUBMISSION. There is no `disabled` on this page. A genuine month-end can legitimately
 * cross the ceiling and rest-day work is sometimes exactly what is needed; the approver weighs that, and
 * they see the same two facts on their own screen.
 *
 * IMPORT DISCIPLINE: attendance services come from @/packs/attendance/service, never @/core/attendance —
 * test/attendance-pack-drift.test.ts is a shrink-only ratchet and the existing direct importers are
 * grandfathered debt, not a pattern to copy.
 */
export default async function ApplyOtPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const t = await getTranslations('me');
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('applyOtPlan')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const today = todayInKualaLumpur();
  // TOMORROW. Derived from the MYT day-key and not from Date.now(): an ISO timestamp plus a day names the
  // day after tomorrow for the eight hours between 00:00 and 08:00 MYT (bb4f2265, the same trap the
  // Attendance Request screen documents on its yesterday helper). Adding a day to a date-only string is
  // plain UTC arithmetic on a KNOWN date, which is the form that must stay UTC.
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : tomorrow;

  const [dayType, cap, lines] = await Promise.all([
    dayTypeFor(s, me.employmentId, date),
    otMonthToDateMinutes(s, me.employmentId, date),
    reportingLinesFor(s, me.employmentId),
  ]);
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  const dayTypeLine =
    dayType === 'rest_day'
      ? t('otDayTypeRestDay', { date })
      : dayType === 'holiday'
        ? t('otDayTypeHoliday', { date })
        : t('otDayTypeOrdinary', { date });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/attendance/plan-ot"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          ← {t('backToPlanOt')}
        </Link>
      </div>
      <PageHeader title={t('applyOtPlan')} description={t('overtimeRequestHelp')} />

      <ErrorBanner message={sp.error} />

      <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="p-5">
          <form action={myRequestOvertime} className="space-y-3">
            {/* The client island: the date box (which drives the warnings beside it), the planned window,
                the derived hours and the reason category. Everything else on this form is server-rendered.
                SERIALISABLE PROPS ONLY — no `t`, no callbacks (test/server-client-boundary.test.ts). */}
            <PlanOtFields
              date={date}
              minutesAlreadyCommitted={cap.totalMinutes}
              capMinutes={cap.capMinutes}
              initialOtMinutes={0}
            />

            <Field label={t('reasonRequired')} required requiredAriaLabel={t('reasonRequired')}>
              <input name="reason" required placeholder={t('otReasonPlaceholder')} className={inputCls} />
            </Field>
            <p className="text-[11px] text-muted-foreground">{t('otReasonOtherHelp')}</p>

            <Field label={t('otGoesToLabel')}>
              {/* Read-only and deliberately NOT a form field: the approver is resolved from the reporting
                  line at decide time (assertCanDecide), so anything posted from here would be ignored at
                  best and misleading at worst. It is here so you know whom to chase. */}
              <div className={`${inputCls} flex items-center bg-muted/40`}>{approver}</div>
            </Field>
            <p className="text-[11px] text-muted-foreground">{t('otGoesToHelp')}</p>

            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-muted-foreground">{t('otNothingSavedUntilSubmit')}</p>
              <Button type="submit" size="sm">
                {t('otSubmitPlan')}
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-3">
          <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200">
            <p className="font-medium">{t('otDayTypeHeading')}</p>
            <p className="mt-1">{dayTypeLine}</p>
          </div>
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
            <p className="font-medium">{t('otWarnNotBlockHeading')}</p>
            <p className="mt-1">{t('otWarnNotBlockBody')}</p>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('otAlreadyApprovedForDate')}</p>
        </div>
      </div>
    </div>
  );
}
