import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/**
 * Sub-navigation within the Leave Settings module (0d147b78 — Leave Settings Reorganization).
 * Mirrors `components/payroll-tabs.tsx` exactly (same markup + active-tab styling) so the leave
 * admin surface reads consistently with Payroll: a row of tabs across the top instead of one long
 * scroll. Each tab is a real sub-route (server component) that loads only its own data.
 */
export async function LeaveTabs({
  active,
}: {
  active: 'types' | 'entitlements' | 'application-rules' | 'approval' | 'payroll' | 'audit';
}) {
  const t = await getTranslations('admin.leaveTabs');
  const tabs = [
    { key: 'types', href: '/admin/leave', label: t('types') },
    { key: 'entitlements', href: '/admin/leave/entitlements', label: t('entitlements') },
    { key: 'application-rules', href: '/admin/leave/application-rules', label: t('applicationRules') },
    { key: 'approval', href: '/admin/leave/approval', label: t('approval') },
    { key: 'payroll', href: '/admin/leave/payroll', label: t('payroll') },
    { key: 'audit', href: '/admin/leave/audit', label: t('audit') },
  ] as const;
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
            active === tab.key
              ? 'border-primary font-medium text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
