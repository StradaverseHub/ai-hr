import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card, PageHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { listCustomReports } from '@/core/custom-reports';
import { MasterReportAccessError } from '@/core/employee-master-access';
import { payrollReconciliationPeriods } from '@/core/report-payroll-comparison';
import { scopedAdmin } from '@/lib/scope';
import { isPayrollComparisonPeriod, previousPayrollComparisonPeriod } from '@/lib/payroll-period-comparison';

export default async function PayrollReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const [t, nav, { template }] = await Promise.all([
    getTranslations('payrollComparison'), getTranslations('nav'), searchParams,
  ]);
  const periods = await payrollReconciliationPeriods(s, scopeIds).catch(error => {
    if (error instanceof MasterReportAccessError) notFound();
    throw error;
  });
  const reports = (await listCustomReports(s, { category: 'payroll', companyIds: scopeIds }))
    .filter(report => report.spec.payrollComparison);
  const chosen = reports.find(report => report.id === template) ?? reports[0];

  return (
    <div className={pageWideCls}>
      <PageHeader title={nav('payrollReconciliation')} description={t('basis')}
        back={{ href: '/payroll', label: t('payroll') }} />
      <Card className="space-y-4 p-5">
        <Link className="text-sm text-primary underline" href="/reports?cat=payroll">{t('customReports')}</Link>
        {reports.length > 0 && <form className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">{t('reportName')}
            <select name="template" className={inputCls} defaultValue={chosen?.id}>
              {reports.map(report => <option key={report.id} value={report.id}>{report.name}</option>)}
            </select>
          </label>
          <button className={btnPrimary}>{t('generate')}</button>
        </form>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="pb-3 text-left font-medium">{t('sourceRuns')}</caption>
            <thead className="border-y border-border"><tr>
              <th className="p-3">{t('columns.company')}</th>
              <th className="p-3">{t('currentPeriod')}</th>
              <th className="p-3">{t('previousPeriod')}</th>
              <th className="p-3">{t('runs')}</th>
              <th className="p-3">{t('comparisonTable')}</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {periods.filter(row => isPayrollComparisonPeriod(row.period)).map(row => {
                const previous = previousPayrollComparisonPeriod(row.period);
                const query = new URLSearchParams({ currentPeriod: row.period, previousPeriod: previous, companyId: row.companyId, runType: 'all' });
                return <tr key={row.companyId + row.period}>
                  <td className="p-3">{row.companyName}</td>
                  <td className="p-3 tabular-nums">{row.period}</td>
                  <td className="p-3 tabular-nums">{previous}</td>
                  <td className="p-3 tabular-nums">{row.runCount}</td>
                  <td className="p-3">{row.requiresReprocessing ? t('needsReview') : chosen
                    ? <Link className="text-primary underline" href={`/reports/payroll-comparison/${chosen.id}?${query}`}>{t('comparisonTable')}</Link>
                    : t('notAvailable')}</td>
                </tr>;
              })}
              {!periods.length && <tr><td className="p-3" colSpan={5}>{t('unavailable')}</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
