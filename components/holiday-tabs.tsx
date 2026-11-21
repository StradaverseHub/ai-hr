import { getTranslations } from 'next-intl/server';
import { HOLIDAY_SUBMENU } from '@/lib/navigation/module-submenus';
import Link from '@/components/intent-link';

/**
 * Sub-navigation within the Holiday module (66b8f5a8 — Holiday Module Enhancement & Centralized Holiday
 * Group Management). Mirrors `components/claims-tabs.tsx` exactly (same markup
 * + active-tab styling) so the holiday admin surface reads consistently: a row of tabs across the top —
 * Holiday (the centralized master list) · Holiday Group (reusable collections HR ticks together) — instead
 * of one long scroll. Each tab is a real sub-route (server component) loading only its own data.
 */
export async function HolidayTabs({ active }: { active: 'holidays' | 'groups' }) {
  const t = await getTranslations('admin.holidayTabs');
  const tabs = HOLIDAY_SUBMENU.map(tab=>({...tab,label:t(tab.labelKey)}));
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          data-navigation-destination={tab.id}
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
