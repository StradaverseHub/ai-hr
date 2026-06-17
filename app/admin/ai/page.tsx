import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getAiConfigView } from '@/core/ai-config';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { AiConfigForm } from '@/components/ai-config-form';

export default async function AiConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.ai');
  const { error } = await searchParams;
  const config = await getAiConfigView(s);
  const envLabel = config.envFallback
    ? config.providers.find((p) => p.provider === config.envFallback!.provider)?.label ?? config.envFallback.provider
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

      {!config.storable && (
        <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('secretMissing')}
        </Card>
      )}

      {config.usingEnvFallback && config.envFallback && (
        <Card className="p-4 text-sm text-muted-foreground">
          {t('usingEnv', { provider: envLabel ?? '', model: config.envFallback.model })}
        </Card>
      )}

      <Card className="p-4 text-xs text-muted-foreground">{t('privacyNote')}</Card>

      <AiConfigForm config={config} />
    </div>
  );
}
