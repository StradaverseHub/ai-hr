import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';

/**
 * Feature 1.2 — Fixed Transaction (v1: re-surface the existing per-employee recurring-component editor).
 * The recurring allowance/deduction editor already lives on the people detail page and writes through the
 * event-logged setEmploymentPayComponent. Per the approved plan, v1 is an employee picker → that existing
 * editor; a company-wide aggregate list is explicitly deferred. No new company-wide cross-table read.
 */
export default async function FixedTransactionPage() {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const employees = await listEmployees(s, scopeIds);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('fixed.title')}
        description={t('fixed.subtitle')}
      />
      <PayrollTabs active="transactions" />

      <Card className="overflow-hidden">
        <SectionHeader title={t('fixed.title')} count={employees.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('fixed.intro')}</p>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('fixed.colEmployee')}</th>
              <th className="px-4 py-2 font-medium">{t('fixed.colCompany')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.employmentId} className="hover:bg-muted/40">
                <td className="px-4 py-2.5 font-medium">{e.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{e.company}</td>
                <td className="px-4 py-2.5 text-right">
                  <Link
                    href={`/personnel/${e.employmentId}`}
                    className="inline-flex items-center rounded-lg border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    {t('fixed.manage')}
                  </Link>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                  {t('fixed.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
