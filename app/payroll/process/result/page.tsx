import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { Badge, Card, ErrorBanner, EmployeeCode, PageHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { listEmployeesForPayrollRun } from '@/core/read';
import { decodeRunGroupResult, type RunGroupReasonCode } from '@/core/payroll-run-group';

/**
 * Payroll Process — Step 3 result summary (feedback 3653d14b, Phase 1).
 *
 * Renders the outcome of a multi-company run from the ONE-SHOT payload carried on the redirect (`?r=`) —
 * there is no persisted run-group row in Phase 1 (the durable audit record is the run-group DomainEvent
 * appended by the orchestrator; a refresh loses this in-request payload by design, per plan §"Run-group
 * record"). Shows the requested header counts, a per-company outcome table with friendly failure reasons,
 * and — as the Phase-1 failed-employee signal — the pre-flight "missing salary" employees who were in scope.
 */
export default async function PayrollProcessResultPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { s } = await scopedAdmin();
  const t = await getTranslations('payroll.process');
  const { r } = await searchParams;
  const result = decodeRunGroupResult(r);

  if (!result) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('resultTitle')} description={t('resultSubtitle')} />
        <PayrollTabs active="batches" />
        <ErrorBanner message={t('resultExpired')} />
        <Link href="/payroll/process" className="text-sm font-medium text-primary hover:underline">
          {t('resultBackToProcess')}
        </Link>
      </div>
    );
  }

  // Organization Module (361e3b15) — an INVALID_CYCLE row names the company AND the missing cycle type (not a
  // bare "no cycle"), reusing the same friendly run-type labels the wizard uses. Other reasons stay as-is.
  const reasonDetail = (c: (typeof result.perCompany)[number]): string =>
    c.reason === 'INVALID_CYCLE' && c.missingCycleRunType
      ? t('payrollCycleMissingForCompanyType', { company: c.companyName, runType: t(`runType.${c.missingCycleRunType}`) })
      : t(`reason.${c.reason as RunGroupReasonCode}`);

  const overallVariant =
    result.overallStatus === 'succeeded' ? 'success' : result.overallStatus === 'partial' ? 'warning' : 'danger';

  // Phase-1 failed-employee table: the pre-flight "missing salary" employees (no current compensation) who
  // were in scope for a company the run actually attempted (succeeded companies — a wholesale-failed company
  // produced no payslips at all, so its employees are reported at company granularity, not per-employee).
  const succeededCompanyIds = result.perCompany.filter((c) => c.status === 'succeeded').map((c) => c.companyId);
  const scopeRows = succeededCompanyIds.length
    ? await listEmployeesForPayrollRun(s, succeededCompanyIds, result.payPeriod)
    : [];
  const missingSalary = scopeRows.filter((e) => !e.hasCurrentCompensation);

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('resultTitle')} description={t('resultSubtitle')} />
      <PayrollTabs active="batches" />

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('overallStatusLabel')}</span>
          <Badge variant={overallVariant}>{t(`overall.${result.overallStatus}`)}</Badge>
          <span className="text-xs text-muted-foreground">{t('resultForPeriod', { period: result.payPeriod })}</span>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label={t('totalCompanies')} value={`${result.totalCompanies}`} sub={t('companiesSplit', { ok: result.companiesSucceeded, failed: result.companiesFailed })} />
          <Stat label={t('totalEmployeesSelected')} value={`${result.totalEmployeesSelected}`} />
          <Stat label={t('totalEmployeesSucceeded')} value={`${result.totalEmployeesSucceeded}`} />
          <Stat label={t('totalEmployeesFailed')} value={`${result.totalEmployeesFailed}`} />
          <Stat label={t('startedAt')} value={fmtTime(result.startedAt)} />
          <Stat label={t('endedAt')} value={fmtTime(result.endedAt)} />
        </dl>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">{t('perCompanyTitle')}</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 font-medium">{t('colSelected')}</th>
                <th className="px-4 py-2 font-medium">{t('colSucceeded')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {result.perCompany.map((c) => (
                <tr key={c.companyId} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium text-foreground">{c.companyName}</td>
                  <td className="px-4 py-2 text-muted-foreground">{c.employeesSelected}</td>
                  <td className="px-4 py-2 text-muted-foreground">{c.employeesSucceeded}</td>
                  <td className="px-4 py-2">
                    {c.status === 'succeeded' ? (
                      <Badge variant="success">{t('companySucceeded')}</Badge>
                    ) : (
                      <Badge variant="danger">{t('companyFailed')}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {c.status === 'failed' && c.reason ? (
                      <span className="text-amber-700 dark:text-amber-400">{reasonDetail(c)}</span>
                    ) : c.batchId ? (
                      <Link href={`/payroll/${c.batchId}`} className="font-medium text-primary hover:underline">
                        {t('viewBatch')}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {missingSalary.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">{t('failedEmployeesTitle')}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('colEmployeeId')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEmployeeName')}</th>
                  <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                  <th className="px-4 py-2 font-medium">{t('colFailureReason')}</th>
                </tr>
              </thead>
              <tbody>
                {missingSalary.map((e) => (
                  <tr key={e.employmentId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2"><EmployeeCode code={e.employeeCode} /></td>
                    <td className="px-4 py-2 text-foreground">{e.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{e.company}</td>
                    <td className="px-4 py-2"><Badge variant="danger">{t('employeeFailed')}</Badge></td>
                    <td className="px-4 py-2 text-amber-700 dark:text-amber-400">{t('reason.MISSING_SALARY')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Link href="/payroll/process" className="text-sm font-medium text-primary hover:underline">
        {t('resultBackToProcess')}
      </Link>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-foreground">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}
