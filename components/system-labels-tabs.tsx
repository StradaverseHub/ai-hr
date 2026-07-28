import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/**
 * Sub-navigation within the System Labels module (fbdeee87 — Relocate Profile Options into System Labels).
 * Mirrors `components/leave-tabs.tsx` exactly (same markup + active-tab
 * styling) so the master-data admin surface reads consistently: a row of tabs across the top. Each tab is
 * a real sub-route (server component) that loads only its own data.
 *
 * The two tabs sit over two DELIBERATELY-SEPARATE data models (org labels are per-company typed tables;
 * profile options are a flat tenant-wide catalog) — this is a navigation consolidation, not a data merge.
 */
export async function SystemLabelsTabs({ active }: { active: 'organisation' | 'profile-options' }) {
  const t = await getTranslations('admin.systemLabelsTabs');
  const tabs = [
    { key: 'organisation', href: '/admin/settings/system-labels', label: t('organisation') },
    { key: 'profile-options', href: '/admin/settings/system-labels/profile-options', label: t('profileOptions') },
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
