import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listOnehrLedPeople, ledTabs, type LedTab } from '@/packs/performance/service';
import { PageHeader } from '@/components/ui';
import { LedPeople } from '../onehr/led-people';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WP-E (CF-08) — "What you led". Every authenticated person reaches it; the data is only the people the viewer
 * leads through app.onehr_leader_role (line manager, HOD, BU CEO, BG CEO or group chief seat). Someone who
 * leads nobody sees an empty page, never a refusal that would say more.
 */
export default async function WhatYouLedPage({ searchParams }: { searchParams: Promise<{ cycle?: string; tab?: string }> }) {
  await requireModule('performance');
  const { s } = await scopedSession(), q = await searchParams, t = await getTranslations('onehr.led');
  const data = await listOnehrLedPeople(s, {
    cycleId: q.cycle && UUID.test(q.cycle) ? q.cycle : undefined,
    tab: (ledTabs as readonly string[]).includes(q.tab ?? '') ? (q.tab as LedTab) : undefined,
  });
  return <div className="mx-auto max-w-6xl space-y-6">
    <PageHeader back={{ href: '/performance', label: t('back') }} title={t('title')} description={t('description')}/>
    <LedPeople data={data}/>
  </div>;
}
