import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { requestOwnAttendanceDayAction } from './actions';
import { attendanceForEmploymentRange, attendancePunchesForRange, myAttendanceCorrections, breakMinutesOf, otByRate, flagOf, statusOf, explainAttendanceDay, type AttendanceStatus, type AttendanceFlag } from '@/packs/attendance/service';
import { myEmployment } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader, Button, inputCls, pageWideCls } from '@/components/ui';
import { AttendanceFigureCells } from '@/components/attendance-figure-cells';
import { fmtMin, fmtDayDate } from '@/components/attendance-format';

/** Employee day view: every subject read resolves from the authenticated person's own employment. */
const CORRECTION_MESSAGES: readonly string[] = [
  'correctionForbidden',
  'correctionBadDate',
  'correctionReasonRequired',
  'correctionNothingToChange',
  'correctionRejected',
  'myDayPending',
  'myDayFuture',
  'myDayBadTimes',
];

export default async function MyAttendanceDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ from?: string; to?: string; error?: string; corrected?: string }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  await requireModule('attendance');
  const { s } = await scopedSession();
  const { date } = await params;
  const sp = await searchParams;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('dayTitle')} />
        <ErrorBanner message={t('dayNoRecord')} />
      </div>
    );
  }

  const selected = await myEmployment(s);

  if (!selected) {
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('dayTitle')} />
        <ErrorBanner message={t('dayNoRecord')} />
      </div>
    );
  }

  const [rows, punchesByAttendance, pendingRequests] = await Promise.all([
    attendanceForEmploymentRange(s, selected.employmentId, date, date),
    attendancePunchesForRange(s, selected.employmentId, date, date),
    myAttendanceCorrections(s, selected.employmentId, { date, status: 'pending', limit: 1 }),
  ]);
  const row = rows[0] ?? null;
  const pending = pendingRequests.length > 0;
  const future = date > todayInKualaLumpur();
  // Keyed by attendance id, exactly as the list reads it — no second shape for one fact.
  const punches = row?.attendanceId ? punchesByAttendance.get(row.attendanceId) ?? [] : [];

  const backHref = `/attendance/my-records?${new URLSearchParams({ ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}) }).toString()}`;

  if (!row) {
    return (
      <div className={pageWideCls}>
        <PageHeader title={t('dayTitle')} description={`${selected.name} · ${fmtDayDate(date, locale)}`} />
        <Link href={backHref} className="text-sm font-medium text-primary hover:underline">
          ← {t('myDayBack')}
        </Link>
        <Card className="p-6 text-sm text-muted-foreground">{t('dayNoRecord')}</Card>
      </div>
    );
  }

  const statusText: Record<AttendanceStatus, string> = {
    present: t('statusPresent'),
    absent: t('statusAbsent'),
    rest: t('statusRest'),
    off: t('statusOff'),
    ph: t('statusPh'),
    on_leave: t('statusOnLeave'),
  };
  const flagText: Record<Exclude<AttendanceFlag, null>, string> = {
    late: t('flagLate'),
    under: t('flagUnder'),
    odd: t('flagOdd'),
  };

  const ot = otByRate(row);
  const status = statusOf(row);
  const flag = flagOf(row);

  // The shift's SPAN less its NET scheduled minutes is the unpaid break — the engine's own arithmetic, not
  // a second definition. Null whenever either half is missing (a policy day or a rest day has no shift).
  const breakMinutes = breakMinutesOf(row);

  const Field = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm tabular-nums">{value}</div>
    </div>
  );
  const DASH = '—';

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('dayTitle')} description={`${selected.name} · ${fmtDayDate(date, locale)}`} />

      <Link href={backHref} className="inline-block text-sm font-medium text-primary hover:underline">
        ← {t('myDayBack')}
      </Link>

      {sp.error && CORRECTION_MESSAGES.includes(sp.error) && <ErrorBanner message={t(sp.error)} />}
      {sp.corrected === '1' && !sp.error && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('myDaySubmitted')}
        </div>
      )}

      {/* 1 · SHIFT DETAILS */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('daySecShift')} />
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Field label={t('colShiftCode')} value={row.shiftCode ?? DASH} />
          <Field label={t('colCheckIn')} value={row.shiftStart ?? DASH} />
          <Field label={t('colCheckOut')} value={row.shiftEnd ?? DASH} />
          <Field label={t('colShiftHours')} value={fmtMin(row.scheduledMinutes)} />
        </div>
        {!row.shiftCode && <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('dayNoShift')}</div>}
      </Card>

      {/* 2 · BREAK TIME — derived, and captioned as derived. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('daySecBreak')} />
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Field label={t('daySecBreak')} value={fmtMin(breakMinutes)} />
        </div>
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('dayBreakDerived')}</div>
      </Card>

      {/* 3 · CLOCK DATA — the pair, plus every punch when the day carries more than two. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('daySecClock')} />
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Field label={t('colCheckIn')} value={row.checkInAt?.slice(0, 5) ?? DASH} />
          <Field label={t('colCheckOut')} value={row.checkOutAt?.slice(0, 5) ?? DASH} />
          <Field label={t('colActualHours')} value={fmtMin(row.workedMinutes)} />
          <Field label={t('colStatus')} value={statusText[status]} />
        </div>
        {punches.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('punchTrail')}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {punches.map((p, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 tabular-nums"
                >
                  <span className="font-medium text-foreground">{p.punchAt.slice(0, 5)}</span>
                  <span
                    className={
                      p.direction === 'in'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-indigo-600 dark:text-indigo-400'
                    }
                  >
                    {p.direction === 'in' ? t('punchIn') : t('punchOut')}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 4 · OVERTIME + 5 · IRREGULARITY — the eight cells that came off the list, in the SAME island with
          the SAME working, so this screen and the list can never explain one day two ways. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('daySecOt')} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-right font-medium">{t('colLateness')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colEarlyOut')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOtFlat')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt00')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt10')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt15')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt20')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colOt30')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <AttendanceFigureCells
                  lateMinutes={row.lateMinutes}
                  earlyOutMinutes={row.earlyOutMinutes}
                  ot={ot}
                  hasRow={row.attendanceId != null}
                  explanation={explainAttendanceDay(row.calcTrace)}
                />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('daySecIrregular')} />
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Field label={t('colStatus')} value={statusText[status]} />
          <Field label={t('colFlag')} value={flag ? flagText[flag] : DASH} />
          <Field label={t('colLateness')} value={fmtMin(row.lateMinutes)} />
          <Field label={t('colEarlyOut')} value={fmtMin(row.earlyOutMinutes)} />
        </div>
        {pending && <p className="border-t border-border px-4 py-3 text-sm font-medium text-amber-700 dark:text-amber-400">{t('myDayPending')}</p>}
        {future && <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{t('myDayFuture')}</p>}
        <form action={requestOwnAttendanceDayAction} className="border-t border-border px-4 py-3">
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="from" value={sp.from ?? ''} />
          <input type="hidden" name="to" value={sp.to ?? ''} />
          <fieldset disabled={pending || future} className="flex flex-wrap items-end gap-3 disabled:opacity-60">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('colCheckIn')}
              <input type="time" name="checkIn" defaultValue={row.checkInAt?.slice(0, 5) ?? ''} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('colCheckOut')}
              <input type="time" name="checkOut" defaultValue={row.checkOutAt?.slice(0, 5) ?? ''} className={inputCls} />
            </label>
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {t('dayCorrectReason')}
              <input name="reason" required maxLength={500} className={inputCls} />
            </label>
            <Button type="submit" variant="outline" size="sm">{t('myDaySubmit')}</Button>
          </fieldset>
          <p className="mt-3 text-[11px] text-muted-foreground">{t('myDayApprovalNote')}</p>
        </form>
      </Card>
    </div>
  );
}
