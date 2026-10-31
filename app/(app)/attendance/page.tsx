import {OvertimeSummaryValue} from '@/components/formula-overtime-record';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { attendanceMonthSummary } from '@/core/attendance';
import { Card, EmployeeName, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { OtReportExport } from '@/components/ot-report-export';
import { AttendanceTabs } from '@/components/attendance-tabs';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

function Pill({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>{label}</span>
  );
}

const fmtMin = (m: number | null | undefined) =>
  m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

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
 * month stepper). Application review lives in the linked request lists. The single-day table moved to the Daily tab; the
 * admin-only Attendance Allowance panel was removed (it is configured under Shift Settings, per the request).
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    month?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('attendance');
  // ADR-0077 slice 4 — a courtesy redirect when the tenant has not bought this module, so they get
  // an explanation instead of the service error. NOT the control: the reads below refuse on their
  // own (D3), and this guard fails open on an unresolved snapshot. Applied at the module ENTRY
  // point; a deep link skips it and meets the service refusal, which is the correct outcome.
  await requireModule('attendance');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const todayIso = todayInKualaLumpur();
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : todayIso.slice(0, 7);
  const summary = await attendanceMonthSummary(s, { month, companyIds: scopeIds, today: todayIso });
  const monthHref = (m: string) => `/attendance?month=${m}`;
  const summaryPage = paginateRows(summary, parsePageQuery(sp));
  const isAdmin = (s.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

  return (
    <div className={pageWideCls}>
      {/* dde08629 (r319) — FULL WIDTH, the same `pageWideCls` eight other Attendance screens already use
          and test/attendance-screens-layout.test.ts already pins for them. These three were simply never
          added: at `mx-auto max-w-6xl` a sixteen-column table sat in a 72rem middle column with roughly a
          third of a wide monitor as empty margin either side — the reporter's complaint verbatim. The
          one-column rule form stays capped on purpose; see NARROW_FORM_SCREENS in that guard. */}
      <div data-tour="attendance-intro">
        <PageHeader
          title={t('title')}
          actions={
            isAdmin ? (
              <>
                {/* 1c1b321a — Recompute sits BESIDE Import Punches and deliberately NOT in the tab strip:
                    AttendanceTabs renders for every role, while /attendance/recompute is requireAdmin. */}
                <Link
                  href="/attendance/recompute"
                  className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-accent"
                >
                  {t('recompute.entryLabel')}
                </Link>
                <Link
                  href="/attendance/import"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  {t('importPunches')}
                </Link>
              </>
            ) : undefined
          }
        />
      </div>
      <AttendanceTabs active="overview" />
      <ErrorBanner message={sp.error} />
      {/* `id` is the anchor /reports links "Overtime report" at — the OT export control lives in this
          card's header, and landing on the page top left the customer hunting for it. */}
      <Card id="ot-report" className="overflow-hidden" data-tour="attendance-summary">
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
        <Pager
          basePath="/attendance"
          params={{ month: sp.month }}
          state={summaryPage.state}
        />
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
              {summaryPage.rows.map((r) => (
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
                  >
                    <OvertimeSummaryValue summary={r.overtimeSummary}/>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {r.overtimeCapState==='exceeded' && (
                        <Pill label={t('flagOtCap')} cls="bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400" />
                      )}
                      {r.overtimeCapState==='unknown'&&<span className="text-xs text-amber-700 dark:text-amber-300">{t('overtimeRecords.unavailable')}</span>}
                      {r.over45hWeek && (
                        <Pill label={t('flagOver45h')} cls="bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400" />
                      )}
                      {r.overtimeCapState==='within' && !r.over45hWeek && <span className="text-xs text-muted-foreground">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
              {summaryPage.rows.length === 0 && (
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
          {t('overtimeRecords.summaryNote')}
        </p>
      </Card>
    </div>
  );
}
