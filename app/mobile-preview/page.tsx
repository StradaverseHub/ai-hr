import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { MobileApp } from '@/components/mobile-preview/mobile-app';
import { loadMobilePreview } from './data';

/**
 * Mobile App UI/UX preview (ca2f2fef) — a design-preview surface that showcases the future mobile app
 * inside a phone frame. Read-only, with authorized data from the existing web services.
 * `scopedSession()` gates the page (every authenticated role reaches
 * it, matching a stakeholder showcase); it is registered in lib/permissions.ts SCREENS as required by
 * test/function-access.test.ts.
 */
export default async function MobilePreviewPage() {
  const { s, scopeIds } = await scopedSession();
  const locale = await getLocale();
  const data = await loadMobilePreview(s, scopeIds, locale);
  const t = await getTranslations('mobilePreview');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('title')} />
      <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
        {t('live.description')}
      </div>
      <div className="flex justify-center py-2">
        <MobileApp key={`${s.userId}:${data.employment?.id ?? 'none'}`} data={data} />
      </div>
    </div>
  );
}
