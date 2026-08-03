import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/**
 * Sub-navigation within the Leave Settings module (0d147b78 — Leave Settings Reorganization).
 * The house tab-strip idiom (same markup + active-tab styling): a row of tabs across the top instead
 * of one long scroll, each a real sub-route (server component) that loads only its own data. It was
 * modelled on the Payroll strip, which 1459e116 retired in favour of the sidebar flyout — this file is
 * now the reference copy the statutory / system-labels strips point at.
 *
 * 1e4eb8af — the Application Rules tab is GONE. Its two cards had no home of their own left: Leave Year
 * Configuration moved into each leave type's Custom Settings step (beside that type's Leave Year Type
 * override), and the per-company Leave Cycle card was retired as a duplicate of that override. The old
 * route survives as a redirect stub so bookmarks still land somewhere real.
 *
 * 645e67c4 — the Replacement Leave tab is NEW and is a placeholder page (see that file's header for why
 * it holds nothing). It sits after Payroll Related and before Audit so the configuration tabs stay
 * together and Audit remains last, which is the order the strip has always read in.
 */
export async function LeaveTabs({
  active,
}: {
  active: 'types' | 'entitlements' | 'approval' | 'payroll' | 'replacement' | 'audit';
}) {
  const t = await getTranslations('admin.leaveTabs');
  const tabs = [
    { key: 'types', href: '/admin/leave', label: t('types') },
    { key: 'entitlements', href: '/admin/leave/entitlements', label: t('entitlements') },
    { key: 'approval', href: '/admin/leave/approval', label: t('approval') },
    { key: 'payroll', href: '/admin/leave/payroll', label: t('payroll') },
    { key: 'replacement', href: '/admin/leave/replacement', label: t('replacement') },
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
