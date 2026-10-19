'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

const tabs = [
  ['', 'overview'], ['/readiness', 'readiness'], ['/exceptions', 'exceptions'],
  ['/actions', 'actions'], ['/agents', 'agents'], ['/opportunities', 'opportunities'], ['/how-it-works', 'guide'],
] as const;

export function ControlTowerNavigation({ payrollEnabled = true }: { payrollEnabled?: boolean }) {
  const pathname = usePathname();
  const t = useTranslations('controlTower.orchestrator');
  return <nav aria-label={t('navigation')} className="mb-6 flex flex-wrap gap-x-5 gap-y-2 border-b border-border">
    {tabs.filter(([path]) => payrollEnabled || (path !== '/exceptions' && path !== '/actions')).map(([path, label]) => {
      const href = `/control-tower${path}`;
      const active = pathname === href;
      return <Link key={href} href={href} aria-current={active ? 'page' : undefined}
        className={`border-b-2 px-1 py-3 text-sm font-medium outline-offset-4 focus-visible:outline-2 focus-visible:outline-primary ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
        {t(label)}
      </Link>;
    })}
  </nav>;
}
