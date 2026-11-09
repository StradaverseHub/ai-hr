import Link from 'next/link';
import {REWARDS_ADMIN_SUBMENU} from '@/lib/navigation/module-submenus';
import { useTranslations } from 'next-intl';
/** 086915a8 — one tab row across the Rewards admin pages; the current page carries aria-current. */
const tabs = REWARDS_ADMIN_SUBMENU;
export type RewardsAdminTab = typeof tabs[number]['key'];
export function RewardsAdminTabs({ current, librariesOnly=false }: { current: RewardsAdminTab; librariesOnly?:boolean }) {
    const t = useTranslations('rewardsAdminTabs');
    return <nav aria-label={t('label')} className="border-b"><ul className="-mb-px flex flex-wrap gap-x-1">{tabs.filter(({key})=>!librariesOnly||key==='salary'||key==='bonus').map(({key, href, id}) => <li key={key}><Link href={href} data-navigation-destination={id} aria-current={key === current ? 'page' : undefined} className={`inline-block border-b-2 px-3 py-2 text-sm font-medium ${key === current ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}`}>{t(key)}</Link></li>)}</ul></nav>;
}
