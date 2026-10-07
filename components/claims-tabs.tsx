import { getTranslations } from 'next-intl/server';
import Link from '@/components/intent-link';

/**
 * Sub-navigation within the Claims Settings module (ccbd0508 — Claim Module Simplification). Mirrors
 * the house tab-strip idiom exactly so the claims admin surface reads consistently: Claim Types (master
 * data only) · Claim Limits (per Job-Grade entitlement rules) · Reimbursements (payout). Each tab is a real
 * sub-route (server component) loading only its own data — the "Claim Limit submenu" the reporter asked for.
 *
 * 645e67c4 — THIS FILE IS NOW THE REFERENCE COPY for the house tab-strip idiom. components/leave-tabs.tsx
 * held that role and was deleted when Leave config became a sidebar flyout group; the attendance,
 * holiday, statutory and system-labels strips (and company-panel's tab trigger) all point here instead.
 * If this one is ever retired the same way, move the pointer again rather than leaving them dangling.
 */
export async function ClaimsTabs({ active }: { active: 'types' | 'limits' | 'mileage' | 'reimbursements' }) {
  const t = await getTranslations('admin.claimsTabs');
  // e7eb5d83 — "I want claim type, claim limit in different tab". Mileage rates joins as its own sub-route
  // rather than as a panel stacked on the limits page, because everything-on-one-page was the original
  // complaint. Reimbursements stays where it is: it is a live route with bookmarks.
  //
  // e7eb5d83 rev 4 point 2 — THE FORMS TAB IS GONE. A claim type's form is edited inside that claim type's
  // own panel on the Types tab now, so setting one up is one place instead of two. /admin/claims/forms is
  // still a route (a permanent redirect to /admin/claims) so old bookmarks land somewhere, but it must not
  // be reachable as a tab: a second way to EDIT the same rows is exactly the duplication this contests.
  // admin.claimsTabs.forms is left in the catalogues, unused, so restoring the tab is a one-line revert.
  const tabs = [
    { key: 'types', href: '/admin/claims', label: t('types') },
    { key: 'limits', href: '/admin/claims/limits', label: t('limits') },
    { key: 'mileage', href: '/admin/claims/mileage', label: t('mileage') },
    { key: 'reimbursements', href: '/admin/claims/reimbursements', label: t('reimbursements') },
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
