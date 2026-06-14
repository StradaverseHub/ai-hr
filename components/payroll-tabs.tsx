import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/** Sub-navigation within the Payroll module (ADR-0010): batch runs vs statutory reports. */
export async function PayrollTabs({ active }: { active: 'batches' | 'reports' }) {
  const t = await getTranslations('components.payrollTabs');
  const tabs = [
    { key: 'batches', href: '/payroll', label: t('batches') },
    { key: 'reports', href: '/payroll/reports', label: t('reports') },
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
