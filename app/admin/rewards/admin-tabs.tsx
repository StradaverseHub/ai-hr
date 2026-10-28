import Link from 'next/link';
import { useTranslations } from 'next-intl';
/** 086915a8 — one tab row across the three Rewards admin pages; the current page carries aria-current. */
const tabs = [['configuration', '/admin/rewards'], ['shared', '/admin/rewards/shared'], ['access', '/admin/rewards/access']] as const;
export type RewardsAdminTab = typeof tabs[number][0];
export function RewardsAdminTabs({ current }: { current: RewardsAdminTab }) {
    const t = useTranslations('rewardsAdminTabs');
    return <nav aria-label={t('label')} className="border-b"><ul className="-mb-px flex flex-wrap gap-x-1">{tabs.map(([key, href]) => <li key={key}><Link href={href} aria-current={key === current ? 'page' : undefined} className={`inline-block border-b-2 px-3 py-2 text-sm font-medium ${key === current ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}`}>{t(key)}</Link></li>)}</ul></nav>;
}
