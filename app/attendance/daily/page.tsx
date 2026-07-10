import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { attendanceForDate } from '@/core/attendance';
import { listCompanies, listDepartments } from '@/core/read';
import { Avatar, Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { AttendanceTabs } from '@/components/attendance-tabs';
import { checkInAction, checkOutAction } from '../actions';

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

/**
 * Attendance > Records — Daily Attendance tab (314ea061). Daily verification for all employees: the
 * per-employee day table (check-in / check-out / worked hours / OT / status / location + inline check-in-out
 * actions) with a Company / Department / Date filter panel above it. Default: all companies in scope, all
 * departments, today's date; users can change the date to review historical attendance.
 */
export default async function DailyAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; date?: string; company?: string; dept?: string }>;
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

  const [companies, departments] = await Promise.all([
    listCompanies(s),
    listDepartments(s, { companyIds: scopeIds }),
  ]);
  // Company filter narrows the scope to a single company (still fenced by the switcher scope); Department
  // filters via the employee's current assignment. Blank = all companies in scope / all departments.
  const companyFilter = sp.company && scopeIds.includes(sp.company) ? sp.company : undefined;
  const deptFilter = sp.dept && departments.some((d) => d.id === sp.dept) ? sp.dept : undefined;
  const effectiveScope = companyFilter ? [companyFilter] : scopeIds;
  const rows = await attendanceForDate(s, date, effectiveScope, { departmentId: deptFilter });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} />
      <AttendanceTabs active="daily" />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden" data-tour="attendance-day">
        <SectionHeader title={date === todayIso ? t('today') : date} count={rows.length} />
        {/* Filter panel — plain GET form (server-driven, no-JS): Company · Department · Date. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.company')}
            <select name="company" defaultValue={companyFilter ?? ''} className={inputCls}>
              <option value="">{t('filters.allCompanies')}</option>
              {companies
                .filter((c) => scopeIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.department')}
            <select name="dept" defaultValue={deptFilter ?? ''} className={inputCls}>
              <option value="">{t('filters.allDepartments')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.date')}
            <input type="date" name="date" defaultValue={date} className={inputCls} />
          </label>
          <Button type="submit" variant="outline" size="sm">
            {t('filters.apply')}
          </Button>
        </form>
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
                <th className="px-4 py-2 font-medium">{t('colLocation')}</th>
                <th className="px-4 py-2 text-right font-medium" data-tour="attendance-action">{t('colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.employmentId}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} className="size-7 text-[10px]" />
                      {/* Employee ID left-of-name (feedback 38668d9b) */}
                      <EmployeeName code={r.employeeCode} name={r.name} className="font-medium" />
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
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {/* ADR-0070: prefer the matched site name, else raw coordinates, else nothing captured. */}
                    {(() => {
                      const locName = r.checkOutLocationName ?? r.checkInLocationName;
                      const lat = r.checkOutLat ?? r.checkInLat;
                      const lng = r.checkOutLng ?? r.checkInLng;
                      if (locName) return locName;
                      if (lat != null && lng != null) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
                      return '—';
                    })()}
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
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noEmployees')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
