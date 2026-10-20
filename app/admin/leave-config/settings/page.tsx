import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { SCREENS, rolesForGuard, type Role } from '@/lib/permissions';
import { LEAVE_SETTINGS_DESTINATIONS } from '@/packs/leave';
import { LEAVE_CONFIG_MAP, leaveConfigPageHeader, type MappedLeaveConfigScreenId } from '@/components/leave-config-map';
import { Card, PageHeader, pageWideCls } from '@/components/ui';

/** Navigation only. The existing destination guard and writer continue to decide access and changes. */
export default async function LeaveSettingsPage() {
  const session = await requireAdmin();
  const t = await getTranslations('leaveSettingsHub');
  const allowed = LEAVE_SETTINGS_DESTINATIONS.filter(row => {
    const screen = SCREENS.find(screen => screen.routes.includes(row.href));
    return screen && (session.roles ?? []).some(role => rolesForGuard(screen.guard).has(role as Role));
  });
  const cards = await Promise.all(allowed.map(async row => {
    const group = LEAVE_CONFIG_MAP.find(group => group.navKey === row.labelKey)!;
    return { ...row, ...await leaveConfigPageHeader(group.items[0].id as MappedLeaveConfigScreenId) };
  }));
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('subtitle')} />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map(card => <Card key={card.href} className="flex flex-col p-5">
        <h2 className="text-base font-semibold">{card.title}</h2>
        <p className="mt-1 flex-1 text-sm text-muted-foreground">{card.description}</p>
        <Link href={card.href} className="mt-4 inline-flex min-h-11 w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90" aria-label={`${t('open')} — ${card.title}`}>{t('open')}</Link>
      </Card>)}
    </div>
  </div>;
}
