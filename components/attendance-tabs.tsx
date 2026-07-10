import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/**
 * Sub-navigation within Attendance > Records (314ea061 — Attendance Records tabs, Phase 1). Mirrors
 * `components/leave-tabs.tsx` / `claims-tabs.tsx` exactly so the module reads consistently: Overview
 * (month-summary dashboard + corrections), Daily Attendance (per-employee day table + Company/Department/
 * Date filters), Individual Attendance (single-employee date-range enquiry). Each tab is a real sub-route
 * (server component) loading only its own data.
 */
export async function AttendanceTabs({ active }: { active: 'overview' | 'daily' | 'individual' }) {
  const t = await getTranslations('attendance.tabs');
  const tabs = [
    { key: 'overview', href: '/attendance', label: t('overview') },
    { key: 'daily', href: '/attendance/daily', label: t('daily') },
    { key: 'individual', href: '/attendance/individual', label: t('individual') },
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
