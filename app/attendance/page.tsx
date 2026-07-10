import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { attendanceMonthSummary, listAttendanceCorrections } from '@/core/attendance';
import { Avatar, Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { OtReportExport } from '@/components/ot-report-export';
import { AttendanceTabs } from '@/components/attendance-tabs';
import { decideCorrectionAction } from './actions';

function Pill({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>{label}</span>
  );
}

const fmtMin = (m: number | null | undefined) =>
  m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const fmtOt = (m: number | null | undefined) => (!m ? '—' : fmtMin(m));

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Attendance > Records — Overview tab (314ea061). The month-summary dashboard (with OT-report export +
 * month stepper) plus the pending-corrections worklist. The single-day table moved to the Daily tab; the
 * admin-only Attendance Allowance panel was removed (it is configured under Shift Settings, per the request).
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; month?: string }>;
}) {
  const t = await getTranslations('attendance');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : todayIso.slice(0, 7);
  const [summary, corrections] = await Promise.all([
    attendanceMonthSummary(s, { month, companyIds: scopeIds, today: todayIso }),
    listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' }),
  ]);
  const monthHref = (m: string) => `/attendance?month=${m}`;
  const isAdmin = (s.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="attendance-intro">
        <PageHeader
          title={t('title')}
          actions={
            isAdmin ? (
              <Link
                href="/attendance/import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('importPunches')}
              </Link>
            ) : undefined
          }
        />
      </div>
      <AttendanceTabs active="overview" />
      <ErrorBanner message={sp.error} />

      {corrections.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('correctionsTitle')} count={corrections.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('colProposed')}</th>
                  <th className="px-4 py-2 font-medium">{t('colReason')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {corrections.map((c) => {
                  // No self-approval (the service enforces it too — this just hides the buttons).
                  const canAct = s.personId == null || c.personId !== s.personId;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.employee} className="size-7 text-[10px]" />
                          <span className="font-medium">{c.employee}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.attendanceDate}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {c.proposedCheckIn
                          ? `${c.proposedCheckIn.slice(0, 5)}${c.proposedCheckOut ? ` → ${c.proposedCheckOut.slice(0, 5)}` : ''}`
                          : ''}
                        {c.requestedOtMinutes != null
                          ? `${c.proposedCheckIn ? ' · ' : ''}${t('otHoursLabel')} ${(c.requestedOtMinutes / 60).toFixed(1)}h`
                          : ''}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{c.reason ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        {canAct ? (
                          <div className="flex justify-end gap-2">
                            <form action={decideCorrectionAction}>
                              <input type="hidden" name="correctionId" value={c.id} />
                              <input type="hidden" name="decision" value="approved" />
                              <Button type="submit" size="sm">
                                {t('approve')}
                              </Button>
                            </form>
                            <form action={decideCorrectionAction}>
                              <input type="hidden" name="correctionId" value={c.id} />
                              <input type="hidden" name="decision" value="rejected" />
                              <Button type="submit" size="sm" variant="outline">
                                {t('reject')}
                              </Button>
                            </form>
                          </div>
                        ) : (
                          <span className="flex justify-end text-xs text-muted-foreground">{t('yourRequest')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {t('correctionsNote')}
          </p>
        </Card>
      )}

      <Card className="overflow-hidden" data-tour="attendance-summary">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {t('monthSummary')}
            <span className="ml-2 text-muted-foreground">{monthLabel(month)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {isAdmin && (
              <OtReportExport
                month={month}
                labels={{
                  export: t('exportOtReport'),
                  format: t('otReportFormat'),
                  csv: t('otReportCsv'),
                  xlsx: t('otReportXlsx'),
                  pdf: t('otReportPdf'),
                }}
              />
            )}
            <Link
              href={monthHref(shiftMonth(month, -1))}
              aria-label={t('previousMonth')}
              className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <Link
              href={monthHref(shiftMonth(month, 1))}
              aria-label={t('nextMonth')}
              className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colPresent')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colLate')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colHalfDay')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colLeave')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colAbsent')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colHours')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colOvertime')}</th>
                <th className="px-4 py-2 font-medium">{t('colFlags')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.map((r) => (
                <tr key={r.employmentId}>
                  {/* Employee ID left-of-name (feedback 38668d9b) */}
                  <td className="px-4 py-2.5 font-medium"><EmployeeName code={r.employeeCode} name={r.name} /></td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.present}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.late || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.halfDay || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.leaveDays || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.absent ? <span className="text-rose-600 dark:text-rose-400">{r.absent}</span> : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {fmtMin(r.workedMinutes)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums text-muted-foreground"
                    title={t('otBreakdown', {
                      workday: fmtOt(r.otWorkday),
                      restDay: fmtOt(r.otRestDay),
                      holiday: fmtOt(r.otHoliday),
                    })}
                  >
                    {fmtOt(r.otWorkday + r.otRestDay + r.otHoliday)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {r.otCapExceeded && (
                        <Pill label={t('flagOtCap')} cls="bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400" />
                      )}
                      {r.over45hWeek && (
                        <Pill label={t('flagOver45h')} cls="bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400" />
                      )}
                      {!r.otCapExceeded && !r.over45hWeek && <span className="text-xs text-muted-foreground">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
              {summary.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noEmployees')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t('summaryNote')}
        </p>
      </Card>
    </div>
  );
}
