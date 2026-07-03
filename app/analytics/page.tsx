import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployees } from '@/core/read';
import { listCostCenters } from '@/core/admin';
import {
  analyticsDateRange,
  carryForwardReport,
  changeJobTransactions,
  demographicsByNationality,
  headcountSummary,
  leaveBalancesSummary,
  leaveUtilisation,
  masterDataExport,
  movementByMonth,
  newHires,
  parseAnalyticsFilters,
  parseReportYear,
  sickLeaveTrend,
  terminations,
  turnoverRateFiltered,
  workforceDemographics,
  type ReportFilter,
} from '@/core/analytics';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { BarChart } from '@/components/charts/BarChart';
import { PieChart } from '@/components/charts/PieChart';
import { LineChart } from '@/components/charts/LineChart';
import { ChartCard } from '@/components/charts/ChartCard';
import { FilterBar } from './FilterBar';
import { bucketLabel, localizeDimension } from './labels';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('analytics');
  const sp = await searchParams;
  const get = (k: string) => sp[k];
  const { from, to } = analyticsDateRange(get);
  // Single filter source of truth — the same parse the export route uses (no screen/export drift).
  const filters = parseAnalyticsFilters(get);
  const filter: ReportFilter = { departmentId: filters.departmentId, q: filters.q };
  const reportYear = parseReportYear(get);

  const [departments, companies, costCentres, employees] = await Promise.all([
    listDepartments(s, { companyIds: scopeIds }),
    listCompanies(s),
    listCostCenters(s, { companyIds: scopeIds }),
    listEmployees(s, scopeIds),
  ]);

  const [hc, hires, terms, turnover, changeJobs, demographics, nationality, leaveUtil, leaveBalances, sickTrend, movement, carryForward] =
    await Promise.all([
      headcountSummary(s, scopeIds, { asOf: to }),
      newHires(s, scopeIds, { from, to, filter }),
      terminations(s, scopeIds, { from, to, filter }),
      turnoverRateFiltered(s, scopeIds, { from, to, filters }),
      changeJobTransactions(s, scopeIds, { from, to, filter }),
      workforceDemographics(s, scopeIds, { asOf: to, filters }),
      demographicsByNationality(s, scopeIds, { asOf: to, filters }),
      leaveUtilisation(s, scopeIds, filters),
      leaveBalancesSummary(s, scopeIds, filters),
      sickLeaveTrend(s, scopeIds, { from, to, filters }),
      movementByMonth(s, scopeIds, { from, to, filters }),
      carryForwardReport(s, scopeIds, { year: reportYear, filter, companyId: filters.companyId }),
    ]);
  const masterCount = (await masterDataExport(s, scopeIds, { includeComp: false, filter })).length;

  // Carry the period + scoping filters onto every export link.
  const filterQs =
    (filters.departmentId ? `&departmentId=${encodeURIComponent(filters.departmentId)}` : '') +
    (filters.q ? `&q=${encodeURIComponent(filters.q)}` : '');
  const exportHref = (report: string, format: string, extra = '') =>
    `/analytics/export?report=${report}&from=${from}&to=${to}&format=${format}${extra}${filterQs}`;
  // Carry-forward report additionally carries `year` + `companyId` (it accepts both, unlike the
  // department/q-only ReportFilter the other detail-table exports use) so its export can never disagree
  // with the on-screen table for the same filter set.
  const carryForwardQs =
    filterQs +
    `&year=${reportYear}` +
    (filters.companyId ? `&companyId=${encodeURIComponent(filters.companyId)}` : '');
  const carryForwardExportHref = (format: string) =>
    `/analytics/export?report=carry-forward&format=${format}${carryForwardQs}`;

  const ExportLink = ({ href, label }: { href: string; label: string }) => (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      ↓ {label}
    </a>
  );

  // CSV / XLSX / PDF button group for a report (+ optional extra query, e.g. &comp=1).
  const FormatGroup = ({ report, extra = '' }: { report: string; extra?: string }) => (
    <div className="inline-flex items-center gap-1.5">
      <ExportLink href={exportHref(report, 'csv', extra)} label={t('exportCsv')} />
      <ExportLink href={exportHref(report, 'xlsx', extra)} label={t('exportXlsx')} />
      <ExportLink href={exportHref(report, 'pdf', extra)} label={t('exportPdf')} />
    </div>
  );

  const tiles: [string, string | number][] = [
    ['activeHeadcount', hc.total],
    ['turnoverRate', `${turnover.turnoverPct}%`],
    ['newHires', hires.length],
    ['terminations', terms.length],
  ];

  // Localize the dimension buckets (enum codes + Unknown/Unassigned sentinels) into chart categories.
  const genderData = demographics.byGender.map((r) => ({ label: bucketLabel(r.name, t, 'gender'), value: r.count }));
  const maritalData = demographics.byMarital.map((r) => ({ label: bucketLabel(r.name, t, 'marital'), value: r.count }));
  const ageData = localizeDimension(demographics.byAgeBand, t, 'plain'); // age bands + Unknown
  const nationalityData = nationality ? localizeDimension(nationality, t, 'nationality') : null;
  const deptData = localizeDimension(demographics.byDepartment, t, 'plain');
  const locationData = localizeDimension(demographics.byLocation, t, 'plain');
  const costCentreData = localizeDimension(demographics.byCostCentre, t, 'plain');
  const statusData = localizeDimension(demographics.byEmploymentStatus, t, 'assignment');
  // Distinct work-states present in the scoped roster → the Location filter options.
  const locationOptions = [...new Set(demographics.byLocation.map((r) => r.name).filter((n) => n !== '__unknown__'))]
    .sort()
    .map((v) => ({ value: v, label: v }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {/* Unified filter bar (form-GET, auto-submit on select change) */}
      <Card>
        <FilterBar
          from={from}
          to={to}
          values={{
            companyId: filters.companyId,
            departmentId: filters.departmentId,
            costCenterId: filters.costCenterId,
            lifecycleStatus: filters.lifecycleStatus,
            assignmentStatus: filters.assignmentStatus,
            gender: filters.gender,
            nationality: filters.nationality,
            workState: filters.workState,
            managerEmploymentId: filters.managerEmploymentId,
          }}
          options={{
            companies: companies.map((c) => ({ value: c.id, label: c.name })),
            departments: departments.map((d) => ({ value: d.id, label: d.name })),
            costCentres: costCentres.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` })),
            managers: employees.map((e) => ({ value: e.employmentId, label: e.name })),
            locations: locationOptions,
          }}
        />
      </Card>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([key, v]) => (
          <div key={key} className="rounded-[1.25rem] border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <div className="text-xs text-muted-foreground">{t(key)}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      {/* ── Workforce demographics ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={t('chartGender')} svgId="chart-gender" filenameBase={`gender_${to}`} exportLabel={t('exportChart')}>
          <PieChart id="chart-gender" data={genderData} ariaLabel={t('chartGender')} />
        </ChartCard>
        <ChartCard title={t('chartMarital')} svgId="chart-marital" filenameBase={`marital_${to}`} exportLabel={t('exportChart')}>
          <PieChart id="chart-marital" data={maritalData} ariaLabel={t('chartMarital')} />
        </ChartCard>
        <ChartCard title={t('chartAgeBand')} svgId="chart-age" filenameBase={`age-band_${to}`} exportLabel={t('exportChart')}>
          <BarChart id="chart-age" categories={ageData.categories} series={[{ label: t('chartAgeBand'), values: ageData.values }]} ariaLabel={t('chartAgeBand')} />
        </ChartCard>
        {nationalityData && (
          <ChartCard
            title={t('chartNationality')}
            svgId="chart-nationality"
            filenameBase={`nationality_${to}`}
            exportLabel={t('exportChart')}
            footnote={t('nationalityFootnote')}
          >
            <BarChart
              id="chart-nationality"
              categories={nationalityData.categories}
              series={[{ label: t('chartNationality'), values: nationalityData.values }]}
              ariaLabel={t('chartNationality')}
            />
          </ChartCard>
        )}
      </div>

      {/* ── Headcount (dept / company / location) ──────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={t('chartHeadcountByDept')} svgId="chart-hc-dept" filenameBase={`headcount-dept_${to}`} exportLabel={t('exportChart')}>
          <BarChart id="chart-hc-dept" categories={deptData.categories} series={[{ label: t('chartHeadcountByDept'), values: deptData.values }]} ariaLabel={t('chartHeadcountByDept')} />
        </ChartCard>
        <ChartCard title={t('chartHeadcountByLocation')} svgId="chart-hc-loc" filenameBase={`headcount-location_${to}`} exportLabel={t('exportChart')}>
          <BarChart id="chart-hc-loc" categories={locationData.categories} series={[{ label: t('chartHeadcountByLocation'), values: locationData.values }]} ariaLabel={t('chartHeadcountByLocation')} />
        </ChartCard>
        <ChartCard title={t('chartHeadcountByCostCentre')} svgId="chart-hc-cc" filenameBase={`headcount-costcentre_${to}`} exportLabel={t('exportChart')}>
          <BarChart id="chart-hc-cc" categories={costCentreData.categories} series={[{ label: t('chartHeadcountByCostCentre'), values: costCentreData.values }]} ariaLabel={t('chartHeadcountByCostCentre')} />
        </ChartCard>
        <ChartCard title={t('chartEmploymentStatus')} svgId="chart-asg-status" filenameBase={`employment-status_${to}`} exportLabel={t('exportChart')}>
          <BarChart id="chart-asg-status" categories={statusData.categories} series={[{ label: t('chartEmploymentStatus'), values: statusData.values }]} ariaLabel={t('chartEmploymentStatus')} />
        </ChartCard>
      </div>

      {/* ── Leave ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={t('chartLeaveUtilisation')} svgId="chart-leave-util" filenameBase={`leave-utilisation_${to}`} exportLabel={t('exportChart')}>
          <BarChart
            id="chart-leave-util"
            grouped
            categories={leaveUtil.map((r) => r.name)}
            series={[
              { label: t('leaveGranted'), values: leaveUtil.map((r) => r.granted) },
              { label: t('leaveTaken'), values: leaveUtil.map((r) => r.taken) },
            ]}
            ariaLabel={t('chartLeaveUtilisation')}
          />
        </ChartCard>
        <ChartCard title={t('chartLeaveBalances')} svgId="chart-leave-bal" filenameBase={`leave-balances_${to}`} exportLabel={t('exportChart')}>
          <BarChart id="chart-leave-bal" categories={leaveBalances.map((r) => r.name)} series={[{ label: t('chartLeaveBalances'), values: leaveBalances.map((r) => r.balance) }]} ariaLabel={t('chartLeaveBalances')} />
        </ChartCard>
        <ChartCard
          title={t('chartSickTrend')}
          svgId="chart-sick"
          filenameBase={`sick-trend_${from}_${to}`}
          exportLabel={t('exportChart')}
          isEmpty={!sickTrend.configured}
          emptyLabel={t('sickNotConfigured')}
        >
          <LineChart id="chart-sick" labels={sickTrend.series.map((r) => r.month)} series={[{ label: t('chartSickTrend'), values: sickTrend.series.map((r) => r.days) }]} ariaLabel={t('chartSickTrend')} />
        </ChartCard>
      </div>

      {/* Carry-forward & forfeiture (Leave Module — carry-forward + expiry + auto forfeit) */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('carryForwardTitle')} count={carryForward.length} />
          <div className="flex items-center gap-3">
            <form method="get" className="flex items-center gap-1.5">
              {/* Preserve every other query param (department/company/q/from/to) — only `year` changes. */}
              {filters.departmentId && <input type="hidden" name="departmentId" value={filters.departmentId} />}
              {filters.companyId && <input type="hidden" name="companyId" value={filters.companyId} />}
              {filters.q && <input type="hidden" name="q" value={filters.q} />}
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t('carryForwardYear')}
                <select
                  name="year"
                  defaultValue={String(reportYear)}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {Array.from({ length: 6 }, (_, i) => reportYear - 4 + i).map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
            </form>
            <div className="inline-flex items-center gap-1.5">
              <ExportLink href={carryForwardExportHref('csv')} label={t('exportCsv')} />
              <ExportLink href={carryForwardExportHref('xlsx')} label={t('exportXlsx')} />
              <ExportLink href={carryForwardExportHref('pdf')} label={t('exportPdf')} />
            </div>
          </div>
        </div>
        <p className="px-4 pb-2 text-xs text-muted-foreground">{t('carryForwardDesc')}</p>
        <Table
          head={[
            t('colName'),
            t('colDepartment'),
            t('carryForwardCarried'),
            t('carryForwardExpiryDate'),
            t('carryForwardForfeitedOpen'),
            t('carryForwardForfeitedExpiry'),
            t('colReason'),
          ]}
          rows={carryForward.map((r) => [
            r.employeeName,
            r.department ?? '—',
            r.carried,
            r.carryForwardExpiryDate ?? '—',
            r.forfeitedAtOpen,
            r.forfeitedAtExpiry,
            r.reasonCodes.length > 0
              ? r.reasonCodes
                  .map((code) => (code === 'cap' ? t('carryForwardReasonCap') : t('carryForwardReasonExpiry')))
                  .join('; ')
              : '—',
          ])}
          empty={t('noData')}
        />
      </Card>

      {/* ── Employee movement ──────────────────────────────────────────────── */}
      <ChartCard title={t('chartMovement')} svgId="chart-movement" filenameBase={`movement_${from}_${to}`} exportLabel={t('exportChart')}>
        <LineChart
          id="chart-movement"
          labels={movement.map((r) => r.month)}
          series={[
            { label: t('movementHires'), values: movement.map((r) => r.hires) },
            { label: t('movementLeavers'), values: movement.map((r) => r.leavers) },
            { label: t('movementNet'), values: movement.map((r) => r.netChange) },
          ]}
          ariaLabel={t('chartMovement')}
        />
      </ChartCard>

      {/* Headcount by department */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('headcountByDept')} count={hc.total} />
        <div className="divide-y divide-border">
          {hc.byDepartment.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noData')}</div>
          )}
          {hc.byDepartment.map((r) => (
            <div key={r.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span>{r.name}</span>
              <span className="font-medium tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Turnover detail */}
      <Card>
        <SectionHeader title={t('turnoverTitle')} />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
          {(
            [
              ['turnoverRate', `${turnover.turnoverPct}%`],
              ['leavers', turnover.leavers],
              ['headcountStart', turnover.headcountStart],
              ['headcountEnd', turnover.headcountEnd],
            ] as const
          ).map(([key, v]) => (
            <div key={key} className="bg-card p-4">
              <div className="text-xs text-muted-foreground">{t(key)}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        <p className="px-4 pb-4 pt-3 text-xs text-muted-foreground">{t('turnoverFormula')}</p>
      </Card>

      {/* New hires */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('newHiresTitle')} count={hires.length} />
          <FormatGroup report="new-hires" />
        </div>
        <Table
          head={[t('colName'), t('colCompany'), t('colDepartment'), t('colHiredOn')]}
          rows={hires.map((r) => [r.name, r.company, r.department ?? '—', r.hiredOn])}
          empty={t('noData')}
        />
      </Card>

      {/* Terminations */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('terminationsTitle')} count={terms.length} />
          <FormatGroup report="terminations" />
        </div>
        <Table
          head={[t('colName'), t('colDepartment'), t('colTerminatedOn'), t('colType'), t('colReason')]}
          rows={terms.map((r) => [
            r.name,
            r.department ?? '—',
            r.terminatedOn ?? '—',
            r.terminationType ? t(`term_${r.terminationType}`) : '—',
            r.terminationReason ?? '—',
          ])}
          empty={t('noData')}
        />
      </Card>

      {/* Change job transactions (ADR-0047) */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('changeJobsTitle')} count={changeJobs.length} />
          <FormatGroup report="change-jobs" />
        </div>
        <Table
          head={[
            t('colName'),
            t('colFromDept'),
            t('colToDept'),
            t('colFromPosition'),
            t('colToPosition'),
            t('colEffectiveOn'),
          ]}
          rows={changeJobs.map((r) => [
            r.name,
            r.fromDepartment ?? '—',
            r.toDepartment ?? '—',
            r.fromPosition ?? '—',
            r.toPosition ?? '—',
            r.effectiveOn,
          ])}
          empty={t('noData')}
        />
      </Card>

      {/* Master-data export */}
      <Card>
        <SectionHeader title={t('masterDataTitle')} count={masterCount} />
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">{t('masterDataDesc')}</p>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-xs font-medium text-muted-foreground">{t('exportWithoutComp')}</span>
              <FormatGroup report="master-data" />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-xs font-medium text-muted-foreground">{t('exportWithComp')}</span>
              <FormatGroup report="master-data" extra="&comp=1" />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-xs font-medium text-muted-foreground">{t('exportAll')}</span>
              <FormatGroup report="master-data" extra="&all=1&comp=1" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('pdfNonLatinNote')}</p>
        </div>
      </Card>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: (string | number)[][];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2.5 tabular-nums">
                  {c}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="px-4 py-8 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
