import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { MobileApp } from '@/components/mobile-preview/mobile-app';
import { isGroupAdmin } from '@/lib/authz';
import { mobileBuilderState, publishedMobileDesign } from '@/core/mobile-design';
import { MobileBuilder } from '@/components/mobile-preview/mobile-builder';
import { loadMobilePreview } from './data';

/** Tenant builder for group administrators; published experience for other authenticated viewers. */
export default async function MobilePreviewPage({ searchParams }: { searchParams: Promise<{ live?: string }> }) {
  const { s, scopeIds } = await scopedSession();
  const locale = await getLocale();
  const data = await loadMobilePreview(s, scopeIds, locale);
  const t = await getTranslations('mobilePreview');

  const live = (await searchParams).live === '1';
  if (isGroupAdmin(s) && !live) {
    const initial = await mobileBuilderState(s);
    return <MobileBuilder key={`${s.tenantId}:${initial.draftRevision}`} initial={initial} data={data} />;
  }
  const published = await publishedMobileDesign(s);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('title')} />
      {isGroupAdmin(s) && <a href="/mobile-preview" className="text-sm underline">{t('builder.exitLive')}</a>}
      <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
        {t('builder.liveWarning')}
      </div>
      <div className="flex justify-center py-2">
        <MobileApp key={`${s.userId}:${data.employment?.id ?? 'none'}`} data={data} design={published.config} />
      </div>
    </div>
  );
}
