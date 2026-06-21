import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { attendanceForDate, attendanceMonthSummary, listAttendanceCorrections } from '@/core/attendance';
import { Avatar, Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { TimelineNav } from '@/components/timeline-nav';
import { checkInAction, checkOutAction, decideCorrectionAction } from './actions';

const STATUS: Record<string, string> = {
  present: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  late: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  half_day: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  absent: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
const CONTEXT_CLS: Record<string, string> = {
  on_leave: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  holiday: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  rest_day: 'bg-muted text-muted-foreground',
};

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

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; date?: string; month?: string }>;
}) {
  const t = await getTranslations('attendance');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const contextLabels: Record<string, string> = {
    on_leave: t('contextOnLeave'),
    holiday: t('contextHoliday'),
    rest_day: t('contextRestDay'),
  };
  const statusLabels: Record<string, string> = {
    present: t('statusPresent'),
    late: t('statusLate'),
    half_day: t('statusHalfDay'),
    absent: t('statusAbsent'),
  };
  const statusLabel = (status: string) => statusLabels[status] ?? status.replace(/_/g, ' ');
  const todayIso = new Date().toISOString().slice(0, 10);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : date.slice(0, 7);
  const [rows, summary, corrections] = await Promise.all([
    attendanceForDate(s, date, scopeIds),
    attendanceMonthSummary(s, { month, companyIds: scopeIds, today: todayIso }),
    listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' }),
  ]);
  const monthHref = (m: string) => `/attendance?date=${date}&month=${m}`;
  const isAdmin = (s.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="attendance-intro">
        <PageHeader
          title={t('title')}
          actions={
            <div className="flex items-center gap-3">
              {isAdmin && (
                <Link
                  href="/attendance/import"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  {t('importPunches')}
                </Link>
              )}
              <TimelineNav from={date} isDefault={date === todayIso} basePath="/attendance" param="date" stepDays={1} />
            </div>
          }
        />
      </div>
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden" data-tour="attendance-day">
        <SectionHeader title={date === todayIso ? t('today') : date} count={rows.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 font-medium">{t('colCheckIn')}</th>
                <th className="px-4 py-2 font-medium">{t('colCheckOut')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colHours')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colOvertime')}</th>
                <th className="px-4 py-2 font-medium" data-tour="attendance-status">{t('colStatus')}</th>
                <th className="px-4 py-2 text-right font-medium" data-tour="attendance-action">{t('colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.employmentId}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} className="size-7 text-[10px]" />
                      <span className="font-medium">{r.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.checkInAt?.slice(0, 5) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.checkOutAt?.slice(0, 5) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {fmtMin(r.workedMinutes)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums text-muted-foreground"
                    title={r.dayType && r.dayType !== 'workday' ? t('otClass', { dayType: r.dayType.replace('_', ' ') }) : undefined}
                  >
                    {fmtOt(r.otMinutes)}
                    {(r.otMinutes ?? 0) > 0 && r.dayType !== 'workday' && (
                      <span className="ml-1 text-[10px] uppercase text-amber-600 dark:text-amber-400">
                        {r.dayType === 'holiday' ? t('otCodePh') : t('otCodeRd')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.attendanceId && r.status ? (
                      <Pill label={statusLabel(r.status)} cls={STATUS[r.status] ?? STATUS.absent} />
                    ) : r.context ? (
                      <Pill label={contextLabels[r.context] ?? r.context} cls={CONTEXT_CLS[r.context] ?? ''} />
                    ) : (
                      <Pill label={t('statusAbsent')} cls={STATUS.absent} />
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end">
                      {!r.attendanceId ? (
                        <form action={checkInAction} className="flex items-center gap-2">
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <input type="hidden" name="date" value={date} />
                          <input name="time" type="time" defaultValue="09:00" className={`${inputCls} h-8 w-28`} />
                          <Button type="submit" size="sm">
                            {t('checkIn')}
                          </Button>
                        </form>
                      ) : !r.checkOutAt ? (
                        <form action={checkOutAction} className="flex items-center gap-2">
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <input type="hidden" name="date" value={date} />
                          <input name="time" type="time" defaultValue="18:00" className={`${inputCls} h-8 w-28`} />
                          <Button type="submit" size="sm" variant="secondary">
                            {t('checkOut')}
                          </Button>
                        </form>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('done')}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

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
                        {c.proposedCheckIn.slice(0, 5)}
                        {c.proposedCheckOut ? ` → ${c.proposedCheckOut.slice(0, 5)}` : ''}
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
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
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
