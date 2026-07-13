import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

/**
 * Sub-navigation within the Statutory Configuration module (31646c85 — Statutory Configuration UI
 * Redesign). Mirrors `components/leave-tabs.tsx` / `components/payroll-tabs.tsx` exactly (same markup +
 * active-tab styling, precedent 0d147b78 Leave Settings Reorganization) so the statutory admin surface
 * reads as one long scroll no more: an Overview tab plus one tab per statutory body. Each tab is a real
 * sub-route (server component) that loads only its own body's data and surfaces that body's own built-in
 * version record (ADR-0037 #6).
 *
 * 'ot' is deliberately NOT a tab — overtime rates are owned by the Attendance Policy screen (feedback
 * e776d17d), not statutory settings. Respect hazard H1: filter 'ot' at render sites only; never remove it
 * from STATUTORY_BODIES.
 */
export async function StatutoryTabs({
  active,
}: {
  active: 'overview' | 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb' | 'hrdf';
}) {
  const t = await getTranslations('payroll.config');
  const tabs = [
    { key: 'overview', href: '/payroll/configuration', label: t('tabOverview') },
    { key: 'epf', href: '/payroll/configuration/epf', label: t('body_epf') },
    { key: 'socso', href: '/payroll/configuration/socso', label: t('body_socso') },
    // SKBBK sits next to SOCSO — it is an employee-paid leg carried ON the SOCSO bands (674ff6a5). It has
    // its own tab for viewing/maintaining the schedule but is NOT an independently-versioned statutory body.
    { key: 'skbbk', href: '/payroll/configuration/skbbk', label: t('body_skbbk') },
    { key: 'eis', href: '/payroll/configuration/eis', label: t('body_eis') },
    { key: 'pcb', href: '/payroll/configuration/pcb', label: t('body_pcb') },
    { key: 'hrdf', href: '/payroll/configuration/hrdf', label: t('body_hrdf') },
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
