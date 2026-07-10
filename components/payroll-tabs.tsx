import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/** Sub-navigation within the Payroll module (ADR-0010): batch runs, transactions, statutory reports. */
export async function PayrollTabs({
  active,
}: {
  active: 'batches' | 'guide' | 'transactions' | 'view' | 'reports' | 'setup';
}) {
  const t = await getTranslations('components.payrollTabs');
  const tabs = [
    { key: 'batches', href: '/payroll', label: t('batches') },
    // Guided end-to-end payroll workflow view (feedback 5db3ae48): signposts Phase 1→6 and surfaces
    // config-level readiness; links OUT to the existing screens rather than duplicating them.
    { key: 'guide', href: '/payroll/guide', label: t('guide') },
    { key: 'transactions', href: '/payroll/transactions', label: t('transactions') },
    { key: 'view', href: '/payroll/transaction-view', label: t('view') },
    { key: 'reports', href: '/payroll/reports', label: t('reports') },
    { key: 'setup', href: '/payroll/setup', label: t('setup') },
  ] as const;
  return (
    <div className="flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            active === t.key
              ? 'border-primary font-medium text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
