import { Fragment } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { attendanceForEmploymentRange, attendancePunchesForRange } from '@/core/attendance';
import { flagOf, statusOf } from '@/core/attendance-derive';
import { listEmployees } from '@/core/read';
import { Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { AttendanceTabs } from '@/components/attendance-tabs';
import { fmtDayDate, fmtDayName } from '@/components/attendance-format';
import { AttendanceDayCells, AttendanceTrailRow, dayCellLabels } from '@/components/attendance-day-cells';
import { cookies } from 'next/headers';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;

/**
 * dae7a10f — this screen's OWN panel cookie. Collapsing the list here says nothing about Attendance
 * Breakdown or Transaction View, which is the whole reason the component takes a key rather than owning
 * one (r320).
 */
const PANEL_COOKIE = 'attendance-individual-panel';


/**
 * Attendance > Records — Individual Attendance tab. Enhanced per-employee, per-day verification table
 * (feedback bbada39c): the assigned Shift Code, scheduled-vs-actual hours, the day's lateness and early-out,
 * the day's overtime split across the rate buckets, a single always-present Status (Absent in red only) and
 * an operational Flag (Late / Under / Odd). The Employee / Date From / Date To filters are unchanged.
 *
 * Read-only: no DomainEvent — this enquiry persists nothing (the substrate skip is deliberate). The
 * Approved/Lock capability is the separate attendance-correction workflow surfaced on the Overview
 * worklist; it is not a per-row control on this read-only enquiry (documented product decision).
 */
export default async function IndividualAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    emp?: string;
    from?: string;
    to?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('attendance');
  const locale = await getLocale();
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  // r432 — status/flag wording and the cells/trail are shared with Daily Attendance (components/attendance-day-cells).
  const labels = dayCellLabels(t);
  const todayIso = todayInKualaLumpur();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = sp.from && dateRe.test(sp.from) ? sp.from : firstOfMonth(todayIso);
  const to = sp.to && dateRe.test(sp.to) ? sp.to : todayIso;

  const employees = await listEmployees(s, scopeIds);
  const selectedEmp = sp.emp && employees.some((e) => e.employmentId === sp.emp) ? sp.emp : undefined;
  const selected = employees.find((e) => e.employmentId === selectedEmp);
  const rows = selectedEmp ? await attendanceForEmploymentRange(s, selectedEmp, from, to) : [];
  // fc776376 — one row per day over the chosen range: a genuine list that grows with the range.
  const { rows: dayPage, state: pgState } = paginateRows(rows, parsePageQuery(sp));
  // R45 92bdf77a — the full punch trail per day (multiple clocking). Keyed by attendanceId; the summary
  // columns still use the row's first-in / last-out, this only expands the audit detail below a multi-punch day.
  const punchesByAttendance = selectedEmp ? await attendancePunchesForRange(s, selectedEmp, from, to) : new Map();

  /**
   * The panel is fed from the SAME `listEmployees(s, scopeIds)` the dropdown used — it must never become a
   * second, wider source of employees. `selectedEmp` above is still re-guarded against this very list
   * before any read uses it, so the list is what is DISPLAYED and never what grants access.
   */
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  /** Read on the SERVER, so the first paint is already right rather than opening and folding (r320). */
  const panelDefaultOpen = (await cookies()).get(PANEL_COOKIE)?.value !== '0';

  return (
    <div className={pageWideCls}>
      {/* dde08629 (r319) — FULL WIDTH, the same `pageWideCls` eight other Attendance screens already use
          and test/attendance-screens-layout.test.ts already pins for them. These three were simply never
          added: at `mx-auto max-w-6xl` a sixteen-column table sat in a 72rem middle column with roughly a
          third of a wide monitor as empty margin either side — the reporter's complaint verbatim. The
          one-column rule form stays capped on purpose; see NARROW_FORM_SCREENS in that guard. */}
      <PageHeader title={t('title')} />
      <AttendanceTabs active="individual" />
      <ErrorBanner message={sp.error} />

      {/**
       * dae7a10f — THE EMPLOYEE PANEL, a MOUNT and not a design. Same component Payroll › Transaction View
       * and Attendance Breakdown use — six screens after r320 — so this cannot drift into a seventh
       * slightly different picker. It owns the grid: collapsing the panel gives its width to the table.
       *
       * `selectParam="emp"` keeps this screen's existing query parameter, so every link and bookmark
       * anybody already holds still opens the person it always did, and `preserve` carries the date range
       * across a switch — the reporter's "pick a person on the left, read their month on the right".
       *
       * ⚠️ EVERY LABEL IS PRE-TRANSLATED. A translator closure passed from this server component into that
       * client one returns a 500 on EVERY request while tsc, the suite and next build all stay green.
       */}
      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={PANEL_COOKIE}
        title={t('title')}
        hideLabel={t('panel.hide')}
        showLabel={t('panel.show')}
        detailHeader={
          selected ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
              <EmployeeName
                code={selected.employeeCode}
                name={selected.name}
                className="text-sm font-semibold text-foreground"
              />
            </div>
          ) : undefined
        }
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('panel.heading')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('panel.hintIndividual')}</p>
            <div className="mt-3">
              <EmployeeScopePanel
                employees={panelEmployees}
                selectedId={selectedEmp ?? null}
                basePath="/attendance/individual"
                selectParam="emp"
                preserve={{ from, to }}
              />
            </div>
          </Card>
        }
      >
      <Card className="overflow-hidden">
        <SectionHeader
          title={selected ? selected.name : t('individualTitle')}
          count={selectedEmp ? rows.length : undefined}
        />
        {/* Filter panel — plain GET form: Select Employee · Date From · Date To. Unchanged. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          {/* The employee rides the URL now, chosen in the panel — carried here so submitting the dates
              cannot silently clear the selection. The old <select> is gone: two pickers for one value is
              how they come to disagree. */}
          {selectedEmp && <input type="hidden" name="emp" value={selectedEmp} />}
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
          /* Wide table — the extra columns scroll horizontally on narrow screens. */
          <div className="overflow-x-auto">
            {/* f728826a — `w-max min-w-full`, not `w-full`: the same squeeze fixed on Breakdown and Daily this
                  round. w-full compresses every cell below its content width and nowrap text then paints
                  over the next column. Fixed here too rather than waiting for it to be reported. */}
            <table className="w-max min-w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colDate')}</th>
                  <th className="px-3 py-2 font-medium">{t('colDay')}</th>
                  <th className="px-3 py-2 font-medium">{t('colShiftCode')}</th>
                  <th className="px-3 py-2 font-medium">{t('colCheckIn')}</th>
                  <th className="px-3 py-2 font-medium">{t('colCheckOut')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colShiftHours')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colActualHours')}</th>
                  {/* 570fd56e — Lateness, Early Out and the six overtime buckets came OFF this list. Six of
                      them hold 0.00 on an ordinary day and they were the reason an eighteen-column row could
                      not be scanned. They are NOT deleted: the day screen below renders all eight through the
                      SAME AttendanceFigureCells island with the SAME explainAttendanceDay working, so the two
                      surfaces cannot explain one day differently. */}
                  <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                  <th className="px-3 py-2 font-medium">{t('colFlag')}</th>
                  <th className="px-3 py-2 font-medium">{t('colAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dayPage.map((r) => {
                  const status = statusOf(r);
                  const flag = flagOf(r);
                  // R45 — punch trail for a multiple-clocking day (>2 punches). A plain single pair (or fewer)
                  // is already fully shown by the Check In / Check Out columns, so we only expand the extras.
                  const punches: { punchAt: string; direction: 'in' | 'out' }[] = r.attendanceId
                    ? punchesByAttendance.get(r.attendanceId) ?? []
                    : [];
                  const showTrail = punches.length > 2;
                  return (
                    <Fragment key={r.date}>
                    <tr>
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">{fmtDayDate(r.date, locale)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{fmtDayName(r.date, locale)}</td>
                      <AttendanceDayCells row={r} status={status} flag={flag} labels={labels} />
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/attendance/individual/${r.date}?emp=${encodeURIComponent(selectedEmp!)}&from=${from}&to=${to}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {t('dayViewEdit')}
                        </Link>
                      </td>
                    </tr>
                    {showTrail && <AttendanceTrailRow punches={punches} colSpan={10} labels={labels} />}
                    </Fragment>
                  );
                })}
                {dayPage.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noRecords')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <Pager
              basePath="/attendance/individual"
              params={{ emp: sp.emp, from: sp.from, to: sp.to }}
              state={pgState}
            />
          </div>
        )}
      </Card>
      </CollapsibleEmployeePanel>
    </div>
  );
}
