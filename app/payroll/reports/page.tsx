import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listReports, recentReports, reportPreview } from '@/core/reporting';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { DownloadCsv } from '@/components/download-csv';
import { recordReportAction } from './actions';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; reportId?: string; periodKey?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt);
  const companyId = sp.companyId || companies[0]?.id || '';
  const reports = companyId ? await listReports(s, companyId) : [];
  const reportId = sp.reportId || reports[0]?.id || '';
  const periodKey = sp.periodKey || '';
  const canPreview = Boolean(companyId && reportId && periodKey);
  const result = canPreview ? await reportPreview(s, { companyId, reportId, periodKey }) : null;
  const recent = companyId ? await recentReports(s, companyId) : [];
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Payroll</h1>
        <p className="text-sm text-muted-foreground">Statutory &amp; compliance reports</p>
      </div>
      <PayrollTabs active="reports" />
      <ErrorBanner message={sp.error} />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        ⚠️ Layer-A report — a human-readable summary to remit from or hand to an accountant. Byte-exact
        agency files (CP39 / KWSP / PERKESO / bank) come in a later slice, each sourced + verified.
      </div>

      <Card>
        <SectionHeader title="Generate report" />
        <form method="get" className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <Field label="Company">
            <select name="companyId" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Report">
            <select name="reportId" defaultValue={reportId} className={inputCls}>
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Period (YYYY-MM)">
            <input name="periodKey" defaultValue={periodKey} placeholder="2026-07" className={inputCls} />
          </Field>
          <button className={btnPrimary}>Preview</button>
        </form>
      </Card>

      {result && !result.meta.hasBatch && (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No payroll batch found for {companyName.get(companyId)} · {periodKey}. Run payroll for this
            period first.
          </p>
        </Card>
      )}

      {result && result.meta.hasBatch && (
        <>
          {result.readiness.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
              <div className="font-medium">
                {result.readiness.length} employee(s) missing identifiers needed to file:
              </div>
              <ul className="mt-1 list-inside list-disc text-xs">
                {result.readiness.map((r) => (
                  <li key={r.employmentId}>
                    {r.name} — {r.missing.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
            {result.columns
              .filter((c) => c.numeric)
              .map((c) => (
                <div key={c.key} className="bg-card p-4">
                  <div className="text-xs text-muted-foreground">{c.label}</div>
                  <div className="text-lg font-semibold tabular-nums">{rm(result.totals[c.key])}</div>
                </div>
              ))}
          </div>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <SectionHeader title={`${reports.find((r) => r.id === reportId)?.label ?? 'Report'} · ${periodKey}`} count={result.rows.length} />
              <div className="flex items-center gap-2">
                <DownloadCsv
                  columns={result.columns}
                  rows={result.rows}
                  filename={`${reportId}_${periodKey}.csv`}
                />
                <form action={recordReportAction}>
                  <input type="hidden" name="companyId" value={companyId} />
                  <input type="hidden" name="reportId" value={reportId} />
                  <input type="hidden" name="periodKey" value={periodKey} />
                  <button className={btnPrimary}>Record generation</button>
                </form>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.key} className={`px-4 py-2 font-medium ${c.numeric ? 'text-right' : ''}`}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {result.columns.map((c) => (
                        <td
                          key={c.key}
                          className={`px-4 py-2.5 ${c.numeric ? 'text-right tabular-nums' : ''} ${
                            row[c.key] == null || row[c.key] === '' ? 'text-red-500' : ''
                          }`}
                        >
                          {c.numeric
                            ? rm(row[c.key])
                            : (row[c.key] as string) || (c.key === 'name' ? '' : '—')}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td colSpan={result.columns.length} className="px-4 py-8 text-center text-muted-foreground">
                        No payslips in this batch.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title="Recent generations" count={recent.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Report</th>
              <th className="px-4 py-2 font-medium">Period</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Rows</th>
              <th className="px-4 py-2 font-medium">Tables ver.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {recent.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5">{r.reportType}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{r.periodKey}</td>
                <td className="px-4 py-2.5 capitalize text-muted-foreground">{r.status}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{r.rowCount}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.statutoryVersion ?? '—'}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No reports recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
