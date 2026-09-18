import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { attendanceForEmploymentRange, attendancePunchesForRange } from '@/core/attendance';
import { otByRate, flagOf, statusOf, type AttendanceStatus, type AttendanceFlag } from '@/core/attendance-derive';
import { explainAttendanceDay } from '@/core/attendance-explain';
import { listEmployees } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { AttendanceFigureCells } from '@/components/attendance-figure-cells';
import { fmtMin, fmtDayDate } from '@/components/attendance-format';

/**
 * 570fd56e — ATTENDANCE › RECORDS › INDIVIDUAL ATTENDANCE › ONE DAY.
 *
 * The reporter's complaint was that the Individual Attendance list carried eighteen columns, six of them
 * holding an overtime figure that is 0.00 on an ordinary day. The eight calculation columns came off the
 * list; this is where they went. Nothing was deleted.
 *
 * ⚠️ NOT A SECOND SOURCE OF FIGURES. Every number here comes from the SAME range read the list performs
 * (`attendanceForEmploymentRange` for one date) and is rendered through the SAME `AttendanceFigureCells`
 * island with the SAME `explainAttendanceDay(calcTrace)` working. A day screen that derived or formatted a
 * figure of its own would eventually disagree with the list it was opened from, and with the OT report —
 * which is the failure this repo keeps re-learning (8ebf77ae). No read of its own, no arithmetic of its own.
 *
 * EDIT IS A LINK, NOT AN EDITOR. Attendance is changed through the existing correction workflow, which
 * carries its own approval, attachment and cancellation. A second write path to an attendance record would
 * bypass that approval and is how overtime changes with no trail, so "Edit" points at the correction the
 * employee or HR already raises.
 *
 * BREAK TIME IS DERIVED, AND SAID TO BE. There is no break column on `AttendanceRangeRow`: the shift's span
 * (start → end) less its NET scheduled minutes IS the unpaid break, which is the same arithmetic the engine
 * does. The caption says so rather than presenting it as a stored figure.
 *
 * ALLOWANCE IS DELIBERATELY ABSENT. The reporter's list asks for one, but "allowance" is ambiguous in this
 * codebase between a BREAK allowance (`attendance_allowance_policy`, minutes an employee may be away) and a
 * pay allowance (a payroll component). Guessing would put a confident wrong section on a screen about
 * money-adjacent figures, so it is left out and the question is recorded for the reporter.
 */
export default async function IndividualAttendanceDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ emp?: string; from?: string; to?: string }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  const { s, scopeIds } = await scopedSession();
  const { date } = await params;
  const sp = await searchParams;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(date)) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('dayTitle')} />
        <ErrorBanner message={t('dayNoRecord')} />
      </div>
    );
  }

  // The employee is resolved against the caller's own scope, exactly as the list does — the date in the
  // path is not an authorization boundary and must not become one.
  const employees = await listEmployees(s, scopeIds);
  const selected = employees.find((e) => e.employmentId === sp.emp) ?? null;

  if (!selected) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('dayTitle')} />
        <ErrorBanner message={t('dayNoRecord')} />
      </div>
    );
  }

  const [rows, punchesByAttendance] = await Promise.all([
    attendanceForEmploymentRange(s, selected.employmentId, date, date),
    attendancePunchesForRange(s, selected.employmentId, date, date),
  ]);
  const row = rows[0] ?? null;
  // Keyed by attendance id, exactly as the list reads it — no second shape for one fact.
  const punches = row?.attendanceId ? punchesByAttendance.get(row.attendanceId) ?? [] : [];

  const backHref = `/attendance/individual?emp=${encodeURIComponent(selected.employmentId)}${
    sp.from ? `&from=${encodeURIComponent(sp.from)}` : ''
  }${sp.to ? `&to=${encodeURIComponent(sp.to)}` : ''}`;

  if (!row) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('dayTitle')} description={`${selected.name} · ${fmtDayDate(date, locale)}`} />
        <Link href={backHref} className="text-sm font-medium text-primary hover:underline">
          ← {t('dayBackToList')}
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
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const spanMinutes =
    row.shiftStart && row.shiftEnd
      ? (toMin(row.shiftEnd) - toMin(row.shiftStart) + 24 * 60) % (24 * 60) || 24 * 60
      : null;
  const breakMinutes =
    spanMinutes != null && row.scheduledMinutes != null ? Math.max(0, spanMinutes - row.scheduledMinutes) : null;

  const Field = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm tabular-nums">{value}</div>
    </div>
  );
  const DASH = '—';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('dayTitle')} description={`${selected.name} · ${fmtDayDate(date, locale)}`} />

      <Link href={backHref} className="inline-block text-sm font-medium text-primary hover:underline">
        ← {t('dayBackToList')}
      </Link>

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
        <div className="border-t border-border px-4 py-2 text-xs">
          <Link href="/attendance/requests" className="font-medium text-primary hover:underline">
            {t('dayEditCorrection')}
          </Link>
        </div>
      </Card>
    </div>
  );
}
