import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { adminCorrectAttendanceDayAction } from './actions';
import { attendanceForEmploymentRange, attendancePunchesForRange } from '@/core/attendance';
import { breakMinutesOf, otByRate, flagOf, statusOf, type AttendanceStatus, type AttendanceFlag } from '@/core/attendance-derive';
import { explainAttendanceDay } from '@/core/attendance-explain';
import { listEmployees } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader, Button, inputCls, pageWideCls } from '@/components/ui';
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
/**
 * dae7a10f — the message keys the correction action may redirect with. An ALLOWLIST rather than
 * `t(sp.error)` on whatever arrives: `error` is an untrusted url value, and handing an arbitrary string
 * to the translator either prints the raw string back at the operator or throws MISSING_MESSAGE on a
 * screen that was otherwise fine.
 */
const CORRECTION_MESSAGES: readonly string[] = [
  'correctionForbidden',
  'correctionBadDate',
  'correctionReasonRequired',
  'correctionNothingToChange',
  'correctionRejected',
  'correctionPendingAnotherApprover',
];

export default async function IndividualAttendanceDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ emp?: string; from?: string; to?: string; error?: string; corrected?: string }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  const { s, scopeIds } = await scopedSession();
  const { date } = await params;
  const sp = await searchParams;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(date)) {
    return (
      <div className={pageWideCls}>
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
      <div className={pageWideCls}>
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
  /** dae7a10f — the one-action correction is an ADMIN affordance; everyone else keeps the link. */
  const admin = isAdmin(s);
  // Keyed by attendance id, exactly as the list reads it — no second shape for one fact.
  const punches = row?.attendanceId ? punchesByAttendance.get(row.attendanceId) ?? [] : [];

  const backHref = `/attendance/individual?emp=${encodeURIComponent(selected.employmentId)}${
    sp.from ? `&from=${encodeURIComponent(sp.from)}` : ''
  }${sp.to ? `&to=${encodeURIComponent(sp.to)}` : ''}`;

  if (!row) {
    return (
      <div className={pageWideCls}>
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
        ← {t('dayBackToList')}
      </Link>

      {/* dae7a10f — the correction's outcome. The action redirects with a message KEY, never a sentence,
          so the six locales stay the one place wording lives. An unknown key renders nothing rather than
          printing itself at the operator. */}
      {sp.error && CORRECTION_MESSAGES.includes(sp.error) && <ErrorBanner message={t(sp.error)} />}
      {sp.corrected === '1' && !sp.error && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('correctionSaved')}
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
        {/**
          * dae7a10f — THE ONE-ACTION ADMIN CORRECTION, and the link that stays for everyone else.
          *
          * The reporter asked to fix a day "without going through the approval workflow". An
          * administrator no longer waits for anybody: this posts the correction and approves it in the
          * same submit. What it does NOT do is write the attendance row — see actions.ts. The correction
          * still runs through the same engine an approved request runs through, and still leaves the same
          * record of who changed it, when, and why.
          *
          * For a non-admin the affordance is unchanged: the correction workflow they already use.
          */}
        {admin ? (
          <form
            action={adminCorrectAttendanceDayAction}
            className="flex flex-wrap items-end gap-3 border-t border-border px-4 py-3"
          >
            <input type="hidden" name="employmentId" value={selected.employmentId} />
            <input type="hidden" name="date" value={date} />
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
            <Button type="submit" variant="outline" size="sm">
              {t('dayCorrectSave')}
            </Button>
            {/* r368 c8282468 — THIS CAPTION IS AN AUDIT PROMISE, ON THE SCREEN WHERE A FIGURE THAT FEEDS
              * PAY IS CHANGED, SO IT MAY SAY ONLY WHAT THE SYSTEM ACTUALLY KEEPS. `dayCorrectTrailNote`
              * (retired in place, not deleted) claimed "the previous value" as well; nothing anywhere
              * stored it. Step 1 of this round dropped the clause; step 2 made the recording real, and
              * this is the sentence that states it — every figure the correction moves, old value and new
              * value, plus the on-site location check it clears, on the `attendance.amended` event and
              * rendered by /admin/audit (core/attendance.ts AMENDED_FIGURE_COLUMNS).
              *
              * ⚠️ IT NAMES THE AUDIT TRAIL AND NOT THIS SCREEN, DELIBERATELY. This page renders no
              * history, and `core/read.ts` `employeeAudit` filters on an aggregate-id set that excludes
              * attendance — so the personnel Change History card will NOT show a correction. /admin/audit,
              * filtered to Attendance, is the only surface. Widen the sentence only after widening one of
              * those two, or it starts overclaiming again.
              *
              * Item 67268d83 round 2 renders this same key on /attendance/my-records/<date> and must
              * CONSUME it, never re-edit it. CAPTION OWNERSHIP IS c8282468's. */}
            <p className="w-full text-[11px] text-muted-foreground">{t('dayCorrectAuditNote')}</p>
          </form>
        ) : (
          <div className="border-t border-border px-4 py-2 text-xs">
            <Link href="/attendance/requests" className="font-medium text-primary hover:underline">
              {t('dayEditCorrection')}
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
