import { Suspense } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { MobileApp } from '@/components/mobile-preview/mobile-app';
import { isGroupAdmin } from '@/lib/authz';
import { mobileBuilderState, publishedMobileDesign } from '@/core/mobile-design';
import { MobileBuilder } from '@/components/mobile-preview/mobile-builder';
import { loadMobilePreview } from './data';
import type { MobilePreviewData } from '@/components/mobile-preview/types';

/** Tenant builder for group administrators; published experience for other authenticated viewers. */
export default async function MobilePreviewPage({ searchParams }: { searchParams: Promise<{ live?: string }> }) {
  const [{s, scopeIds}, locale, t, query] = await Promise.all([
    scopedSession(), getLocale(), getTranslations('mobilePreview'), searchParams,
  ]);
  const builder = isGroupAdmin(s) && query.live !== '1';
  if (builder) {
    const initial = await mobileBuilderState(s);
    const data = loadMobilePreview(s, scopeIds, locale);
    return <MobileBuilder key={`${s.tenantId}:${initial.draftRevision}`} initial={initial} data={data} />;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('title')} />
      {isGroupAdmin(s) && <a href="/mobile-preview" className="text-sm underline">{t('builder.exitLive')}</a>}
      <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
        {t('builder.liveWarning')}
      </div>
      <div className="flex justify-center py-2">
        <Suspense fallback={<p role="status">{t('live.refreshing')}</p>}>
          <LiveMobilePreview userId={s.userId} data={loadMobilePreview(s, scopeIds, locale)} design={publishedMobileDesign(s)} />
        </Suspense>
      </div>
    </div>
  );
}

async function LiveMobilePreview({userId,data,design}:{
  userId:string|undefined;
  data:Promise<MobilePreviewData>;
  design:ReturnType<typeof publishedMobileDesign>;
}){
  const [preview,published]=await Promise.all([data,design]);
  return <MobileApp key={`${userId}:${preview.employment?.id ?? 'none'}:${published.revision}`} data={preview} design={published.config}/>;
}
