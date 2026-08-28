import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { Badge, Card, ErrorBanner, EmployeeCode, PageHeader } from '@/components/ui';
import { listEmployeesForPayrollRun } from '@/core/read';
// r227 — the skipped are read from the run's own durable event, not carried in the redirect. See below.
import { listSkippedEmployees } from '@/core/payroll-view';
import { decodeRunGroupResult, type RunGroupReasonCode } from '@/core/payroll-run-group';
import { payrollProcessBack } from '../../back';

/**
 * Payroll Process — Step 3 result summary (feedback 3653d14b, Phase 1).
 *
 * Renders the outcome of a multi-company run from the ONE-SHOT payload carried on the redirect (`?r=`) —
 * there is no persisted run-group row in Phase 1 (the durable audit record is the run-group DomainEvent
 * appended by the orchestrator; a refresh loses this in-request payload by design, per plan §"Run-group
 * record"). Shows the requested header counts, a per-company outcome table with friendly failure reasons,
 * and — as the Phase-1 failed-employee signal — the pre-flight "missing salary" employees who were in scope.
 *
 * r226 adds the THIRD outcome: employees an ADDITIONAL run (Bonus / Off-cycle / Adjustment) did not process
 * because it had nothing to pay them in that cycle. They are counted in their own stat, listed BY NAME in
 * their own card, and are deliberately NOT in the red "Failed to process" figure — `summarize` subtracts
 * them there, and the card below carries a neutral badge rather than a danger one, because a skip is a
 * correct decision by the run and not something that went wrong.
 *
 * r227 MOVED THE NAMES OFF THE REDIRECT. r226 carried the whole skipped list inside `?r=`, which took the
 * payload from O(companies) to O(headcount): 40 skipped = 9,298 bytes, 80 = 18,018, 245 = 54,136, against
 * a 16,384-byte header budget. This page therefore failed to load at around seventy skipped employees —
 * on exactly the runs the skip exists for, and AFTER the payroll had already been committed. The payload
 * now carries a COUNT and this page reads the names from each batch's `payroll-batch.processed` event
 * (`listSkippedEmployees`), which the kernel already wrote. Two consequences worth knowing: the card now
 * survives a refresh, and a reader who cannot see those events (they are admin-only under ADR-0015) sees
 * the counts with no name list rather than a page that claims nobody was skipped.
 */
export default async function PayrollProcessResultPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string; from?: string }>;
}) {
  const { s } = await scopedAdmin();
  const t = await getTranslations('payroll.process');
  const { r, from } = await searchParams;
  // 9066bd6c — this screen is the terminal step of the run flow and had no way back at all: the only
  // exit was the browser's own. Back returns the Payroll Process list as it was left. The label and the
  // `payroll.list` lookup live in the shared helper so this page keeps ONE namespace (see app/payroll/back.ts).
  const back = await payrollProcessBack(from);
  const result = decodeRunGroupResult(r);

  if (!result) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader back={back} title={t('resultTitle')} description={t('resultSubtitle')} />
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

  // r226/r227 — every skipped employee, flattened across the run's companies and carrying the company
  // name so a multi-company bonus run reads as one list. Sorted by company then name, so two runs of the
  // same shape print in the same order.
  //
  // Only the batches whose outcome says somebody was skipped are queried, so a run that skipped nobody —
  // every regular run — costs no query at all.
  const skippedCompanies = result.perCompany.filter((c) => (c.employeesSkipped ?? 0) > 0 && c.batchId);
  const companyOfBatch = new Map(skippedCompanies.map((c) => [c.batchId as string, c]));
  const skippedRows = skippedCompanies.length
    ? (await listSkippedEmployees(s, skippedCompanies.map((c) => c.batchId as string)))
        .map((e) => ({
          ...e,
          companyId: companyOfBatch.get(e.batchId)?.companyId ?? '',
          companyName: companyOfBatch.get(e.batchId)?.companyName ?? '',
        }))
        .sort((a, b) => a.companyName.localeCompare(b.companyName) || a.name.localeCompare(b.name))
    : [];

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader back={back} title={t('resultTitle')} description={t('resultSubtitle')} />

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
          {/* r226 — shown only when there is something to say. A payload written before this shipped has
              no `totalEmployeesSkipped` at all, so `?? 0` keeps the old result URLs rendering. */}
          {(result.totalEmployeesSkipped ?? 0) > 0 && (
            <Stat label={t('totalEmployeesSkipped')} value={`${result.totalEmployeesSkipped}`} sub={t('skippedNotAFailure')} />
          )}
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
                <th className="px-4 py-2 font-medium">{t('colSkipped')}</th>
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
                  <td className="px-4 py-2 text-muted-foreground">{c.employeesSkipped ?? 0}</td>
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

      {(result.totalEmployeesSkipped ?? 0) > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <div className="text-sm font-medium">{t('skippedEmployeesTitle')}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t('skippedEmployeesNote')}</p>
          </div>
          {/* r227 — the count comes from the run, the names from its durable event. A reader without
              access to that event (admin-only, ADR-0015) gets the count and this sentence, never a
              silently empty card that would read as "nobody was skipped after all". */}
          {skippedRows.length === 0 && (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              {t('skippedNamesUnavailable', { n: result.totalEmployeesSkipped })}
            </p>
          )}
          {skippedRows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">{t('colEmployeeId')}</th>
                    <th className="px-4 py-2 font-medium">{t('colEmployeeName')}</th>
                    <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                    <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                    <th className="px-4 py-2 font-medium">{t('colSkipReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {skippedRows.map((e) => (
                    <tr key={`${e.batchId}:${e.employmentId}`} className="border-b border-border last:border-0">
                      <td className="px-4 py-2"><EmployeeCode code={e.employeeCode} /></td>
                      <td className="px-4 py-2 text-foreground">{e.name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{e.companyName}</td>
                      {/* NEUTRAL, never danger: nothing went wrong for this person. */}
                      <td className="px-4 py-2"><Badge variant="default">{t('employeeSkipped')}</Badge></td>
                      <td className="px-4 py-2 text-muted-foreground">{t(`skipReason.${e.reason}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

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
