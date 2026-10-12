import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { adminCorrectAttendanceDayAction, saveAttendanceClockDataAction } from './actions';
import { AttendanceClockData } from '@/components/attendance-clock-data';
import { attendanceForEmploymentRange, attendancePunchesForRange } from '@/core/attendance';
import { breakMinutesOf, otByRate, flagOf, statusOf, type AttendanceStatus, type AttendanceFlag } from '@/core/attendance-derive';
import { explainAttendanceDay } from '@/core/attendance-explain';
import { listEmployees } from '@/core/read';
import { employmentScheduleGroupName } from '@/core/roster';
import { attendanceClockData, clockCaptureEvidence } from '@/packs/attendance/service';
import { Card, ErrorBanner, PageHeader, SectionHeader, Button, inputCls, pageWideCls } from '@/components/ui';
import { DayField, DayFieldGrid, DayOvertimeRows } from '@/components/attendance-day-parts';
import { fmtMin, fmtDayDate, fmtCoord, osmPointHref } from '@/components/attendance-format';

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
  'clockDataChanged',
  'clockDataPayrollClosed',
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

  const [rows, punchesByAttendance, scheduleGroup] = await Promise.all([
    attendanceForEmploymentRange(s, selected.employmentId, date, date),
    attendancePunchesForRange(s, selected.employmentId, date, date),
    // r433 (faca1cfb round 1) — the Schedule Group is `employment.attendance_rule_id`, read for display only.
    employmentScheduleGroupName(s, selected.employmentId),
  ]);
  const row = rows[0] ?? null;
  /** dae7a10f — the one-action correction is an ADMIN affordance; everyone else keeps the link. */
  const admin = isAdmin(s);
  const clockData = admin ? await attendanceClockData(s,selected.employmentId,date) : null;
  // Keyed by attendance id, exactly as the list reads it — no second shape for one fact.
  const punches = row?.attendanceId ? punchesByAttendance.get(row.attendanceId) ?? [] : [];
  // r423 (83c0d3c8, plan point 13) — WHERE each self-service clocking was made. Only punches backed by a
  // clock capture have evidence; manual, imported and legacy punches show nothing new. Read under the
  // caller's own session through the pack facade: the capture table's RLS (can_see_employment) is the same
  // visibility as the attendance rows on this page, so nobody sees more than they did.
  const evidence = await clockCaptureEvidence(
    s,
    punches.map((p) => p.clockCaptureId).filter((id): id is string => id != null),
  );

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

  // r433 — ONLY THE ITEMS THAT APPLY. The eight fixed columns are gone; each row is built from the day's
  // STORED results (lateness, early out, the flat bucket and the five rate buckets), the SAME numbers
  // `otByRate` and the row already carried, and a zero is simply not listed. Labels are the existing
  // column-heading keys, written as literals so the key-usage guards still see them.
  const explanation = explainAttendanceDay(row.calcTrace);
  const otCandidates: { only: 'lateness' | 'earlyOut' | 'flat' | 'ot00' | 'ot10' | 'ot15' | 'ot20' | 'ot30'; label: string; minutes: number }[] = [
    { only: 'lateness', label: t('colLateness'), minutes: row.lateMinutes ?? 0 },
    { only: 'earlyOut', label: t('colEarlyOut'), minutes: row.earlyOutMinutes ?? 0 },
    { only: 'flat', label: t('colOtFlat'), minutes: ot.flat },
    { only: 'ot00', label: t('colOt00'), minutes: ot.ot00 },
    { only: 'ot10', label: t('colOt10'), minutes: ot.ot10 },
    { only: 'ot15', label: t('colOt15'), minutes: ot.ot15 },
    { only: 'ot20', label: t('colOt20'), minutes: ot.ot20 },
    { only: 'ot30', label: t('colOt30'), minutes: ot.ot30 },
  ];
  const otItems = otCandidates.filter((c) => c.minutes > 0);

  const Field = DayField;
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

      {/* r433 (faca1cfb round 1) — 0 · EMPLOYEE INFORMATION. Whose day this is. Every value is a column the
          scoped employee read already returns, plus the Schedule Group name; nothing is derived here. */}
      <Card className="overflow-hidden" data-day-section="employee">
        <SectionHeader title={t('daySecEmployee')} />
        <DayFieldGrid>
          <Field label={t('dayInfoName')} value={selected.name} />
          <Field label={t('colEmployeeId')} value={selected.employeeCode ?? DASH} />
          <Field label={t('dayInfoCompany')} value={selected.company ?? DASH} />
          <Field label={t('dayInfoDepartment')} value={selected.department ?? DASH} />
          <Field label={t('dayInfoPosition')} value={selected.position ?? DASH} />
          <Field label={t('dayInfoDate')} value={fmtDayDate(date, locale)} />
          <Field label={t('dayInfoScheduleGroup')} value={scheduleGroup ?? t('dayInfoScheduleGroupNone')} />
        </DayFieldGrid>
      </Card>

      {/* r433 — 1 · CLOCK DATE AND BREAK TIME. The old Shift details and Break time cards, one section: the
          date, the shift period and the break together. The break is DERIVED (shift span less net
          scheduled minutes), never stored, and the caption says so. */}
      <Card className="overflow-hidden" data-day-section="clock-break">
        <SectionHeader title={t('daySecClockBreak')} />
        <DayFieldGrid cols={3}>
          <Field label={t('dayInfoDate')} value={fmtDayDate(date, locale)} />
          <Field
            label={t('dayShiftLabel')}
            value={
              row.shiftCode && row.shiftStart && row.shiftEnd
                ? t('dayShiftPeriod', {
                    shift: row.shiftCode,
                    start: row.shiftStart,
                    end: row.shiftEnd,
                    hours: fmtMin(row.scheduledMinutes),
                  })
                : (row.shiftCode ?? DASH)
            }
          />
          <Field label={t('daySecBreak')} value={fmtMin(breakMinutes)} />
        </DayFieldGrid>
        {!row.shiftCode && <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('dayNoShift')}</div>}
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
                  className="inline-flex flex-col rounded-md border border-border bg-background px-2 py-0.5 tabular-nums"
                >
                  <span className="inline-flex items-center gap-1">
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
                  {(() => {
                    const ev = p.clockCaptureId ? evidence.get(p.clockCaptureId) : undefined;
                    if (!ev) return null;
                    if (ev.geofenced) {
                      return (
                        <span data-clock-evidence="geofenced" className="text-[11px] text-muted-foreground">
                          {t('clockEvidenceGeofenced', {
                            site: ev.locationName ?? DASH,
                            distance: ev.distanceM ?? 0,
                            radius: ev.radiusM ?? 0,
                          })}
                        </span>
                      );
                    }
                    return (
                      <span data-clock-evidence="not-enforced" className="text-[11px] text-muted-foreground">
                        {t('clockEvidenceNotRequired')} ·{' '}
                        <a
                          href={osmPointHref(ev.lat, ev.lng)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {t('clockEvidenceCoordinates', { lat: fmtCoord(ev.lat), lng: fmtCoord(ev.lng), accuracy: Math.round(ev.accuracyM) })}
                        </a>
                      </span>
                    );
                  })()}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      {clockData && <AttendanceClockData data={clockData} employmentId={selected.employmentId} date={date} action={saveAttendanceClockDataAction} />}

      {/* 4 · OVERTIME + 5 · IRREGULARITY — the eight cells that came off the list, in the SAME island with
          the SAME working, so this screen and the list can never explain one day two ways. */}
      <Card className="overflow-hidden" data-day-section="overtime">
        <SectionHeader title={t('daySecOt')} />
        {otItems.length === 0 ? (
          <p data-day-ot-none className="px-4 py-3 text-sm text-muted-foreground">{t('dayOtNone')}</p>
        ) : (
          <>
            <DayOvertimeRows
              items={otItems.map(({ only, label }) => ({ only, label }))}
              figures={{
                lateMinutes: row.lateMinutes,
                earlyOutMinutes: row.earlyOutMinutes,
                ot,
                hasRow: row.attendanceId != null,
                explanation,
              }}
              itemHeading={t('dayOtColItem')}
              amountHeading={t('dayOtColAmount')}
              footnote={t('dayOtOnlyApplicable')}
            />
          </>
        )}
      </Card>

      <Card className="overflow-hidden" data-day-section="irregularity">
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
            className="grid grid-cols-1 gap-3 border-t border-border px-4 py-3 sm:flex sm:flex-wrap sm:items-end"
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
            <label className="flex min-w-0 sm:min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
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
