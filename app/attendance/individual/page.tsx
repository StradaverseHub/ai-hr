import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { attendanceForEmploymentRange } from '@/core/attendance';
import { listEmployees } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader, inputCls, Button } from '@/components/ui';
import { AttendanceTabs } from '@/components/attendance-tabs';

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

const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
const dayName = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

/**
 * Attendance > Records — Individual Attendance tab (314ea061). A single-employee attendance enquiry: pick
 * an employee, choose a date range (default: first-of-month → today), and see one row per calendar day —
 * check-in / check-out / hours / OT and the exception (leave / holiday / rest day / absent) that explains a
 * no-attendance day. No employee is selected until the user picks one.
 */
export default async function IndividualAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; emp?: string; from?: string; to?: string }>;
}) {
  const t = await getTranslations('attendance');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const statusLabels: Record<string, string> = {
    present: t('statusPresent'),
    late: t('statusLate'),
    half_day: t('statusHalfDay'),
    absent: t('statusAbsent'),
  };
  const contextLabels: Record<string, string> = {
    on_leave: t('contextOnLeave'),
    holiday: t('contextHoliday'),
    rest_day: t('contextRestDay'),
  };
  const statusLabel = (status: string) => statusLabels[status] ?? status.replace(/_/g, ' ');
  const todayIso = new Date().toISOString().slice(0, 10);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = sp.from && dateRe.test(sp.from) ? sp.from : firstOfMonth(todayIso);
  const to = sp.to && dateRe.test(sp.to) ? sp.to : todayIso;

  const employees = await listEmployees(s, scopeIds);
  const selectedEmp = sp.emp && employees.some((e) => e.employmentId === sp.emp) ? sp.emp : undefined;
  const selected = employees.find((e) => e.employmentId === selectedEmp);
  const rows = selectedEmp ? await attendanceForEmploymentRange(s, selectedEmp, from, to) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} />
      <AttendanceTabs active="individual" />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SectionHeader
          title={selected ? selected.name : t('individualTitle')}
          count={selectedEmp ? rows.length : undefined}
        />
        {/* Filter panel — plain GET form: Select Employee · Date From · Date To. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.selectEmployee')}
            <select name="emp" defaultValue={selectedEmp ?? ''} className={inputCls}>
              <option value="">{t('filters.chooseEmployee')}</option>
              {employees.map((e) => (
                <option key={e.employmentId} value={e.employmentId}>
                  {e.employeeCode ? `${e.employeeCode} · ${e.name}` : e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.dateFrom')}
            <input type="date" name="from" defaultValue={from} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.dateTo')}
            <input type="date" name="to" defaultValue={to} className={inputCls} />
          </label>
          <Button type="submit" variant="outline" size="sm">
            {t('filters.apply')}
          </Button>
        </form>

        {!selectedEmp ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('filters.pickEmployeePrompt')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('colDay')}</th>
                  <th className="px-4 py-2 font-medium">{t('colCheckIn')}</th>
                  <th className="px-4 py-2 font-medium">{t('colCheckOut')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colHours')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colOvertime')}</th>
                  <th className="px-4 py-2 font-medium">{t('colException')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.date}>
                    <td className="px-4 py-2.5 tabular-nums">{r.date}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{dayName(r.date)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.checkInAt?.slice(0, 5) ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.checkOutAt?.slice(0, 5) ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {fmtMin(r.workedMinutes)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtOt(r.otMinutes)}</td>
                    <td className="px-4 py-2.5">
                      {r.attendanceId && r.status ? (
                        <Pill label={statusLabel(r.status)} cls={STATUS[r.status] ?? STATUS.absent} />
                      ) : r.context ? (
                        <Pill label={contextLabels[r.context] ?? r.context} cls={CONTEXT_CLS[r.context] ?? ''} />
                      ) : (
                        <Pill label={t('statusAbsent')} cls={STATUS.absent} />
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noRecords')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
