import { getTranslations } from 'next-intl/server';
import { ATTENDANCE_SUBMENU } from '@/lib/navigation/module-submenus';
import Link from '@/components/intent-link';

/**
 * Sub-navigation within Attendance > Records (314ea061 — Attendance Records tabs, Phase 1). Mirrors
 * `components/claims-tabs.tsx` exactly so the module reads consistently: Overview
 * (month-summary dashboard + corrections), Daily Attendance (per-employee day table + Company/Department/
 * Date filters), Individual Attendance (single-employee date-range enquiry). Each tab is a real sub-route
 * (server component) loading only its own data.
 */
export async function AttendanceTabs({ active }: { active: 'overview' | 'daily' | 'individual' }) {
  const t = await getTranslations('attendance.tabs');
  const tabs = ATTENDANCE_SUBMENU.map(tab=>({...tab,label:t(tab.labelKey)}));
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
