import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { listCompanies, listDepartments, listEmployees } from '@/core/read';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { BatchCreateForm } from './batch-create-form';
import { addRunAction } from './actions';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  processed: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.list');
  const thisMonth = new Date().toISOString().slice(0, 7); // current YYYY-MM
  // Wave 2C (ADR-0024): the "add run" control is gated — only shown when multi-cycle is enabled.
  const multiCycle = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  const { error } = await searchParams;
  // Note (scope asymmetry, pre-existing): companies come from the UNSCOPED listCompanies, while
  // departments + employees are scope-filtered by scopeIds. A subtree-restricted admin can pick a
  // parent/sibling company in the dropdown whose departments + employees then come back empty → a
  // whole-company run with no ability to subset. This is inherited, not introduced here; scoping the
  // company dropdown too is out of scope for this feature.
  const [batches, companies, departments, employees] = await Promise.all([
    listBatches(s, scopeIds),
    listCompanies(s),
    listDepartments(s, { companyIds: scopeIds }),
    listEmployees(s, scopeIds),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="payroll-intro">
        <PageHeader
          title={t('title')}
          actions={
            <Link
              href="/payroll/history-import"
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              {t('importHistory')}
            </Link>
          }
        />
      </div>
      <PayrollTabs active="batches" />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden" data-tour="payroll-batches">
        <SectionHeader title={t('batches')} count={batches.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
              <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-2 font-medium">{t('colEmployees')}</th>
              <th className="px-4 py-2 font-medium">{t('colNetPay')}</th>
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {batches.map((b) => {
              const totals = b.totals as { net?: number } | null;
              return (
                <tr key={b.id} className="hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <Link href={`/payroll/${b.id}`} className="font-medium hover:text-primary">
                      {b.payPeriod}
                    </Link>
                    {b.runType !== 'regular' && (
                      <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                        {t(`runType.${b.runType}`)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{b.company}</td>
                  <td className="px-4 py-2.5 tabular-nums">{b.employeeCount}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {totals?.net != null ? `RM ${Number(totals.net).toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[b.status]}`}>
                      {t(`status.${b.status}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
            {batches.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <BatchCreateForm companies={companies} departments={departments} employees={employees} thisMonth={thisMonth} />
        {multiCycle && (
          <form action={addRunAction} className="grid grid-cols-1 items-end gap-3 border-t border-border bg-muted/30 p-4 sm:grid-cols-4">
            <Field label={t('company')}>
              <select name="companyId" required className={inputCls}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('payPeriod')}>
              <input name="payPeriod" required placeholder="2026-05" defaultValue={thisMonth} pattern="[0-9]{4}-(0[1-9]|1[0-2])" title="YYYY-MM" className={inputCls} />
            </Field>
            <Field label={t('runTypeLabel')}>
              <select name="runType" required className={inputCls}>
                <option value="bonus">{t('runType.bonus')}</option>
                <option value="off_cycle">{t('runType.off_cycle')}</option>
                <option value="adjustment">{t('runType.adjustment')}</option>
              </select>
            </Field>
            <div>
              <Button type="submit">{t('addRun')}</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
