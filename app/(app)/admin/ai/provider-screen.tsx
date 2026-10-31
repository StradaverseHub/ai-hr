import {createHash} from 'node:crypto';
import {getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getAiConfigView } from '@/core/ai-config';
import { Card, ErrorBanner } from '@/components/ui';
import { AiConfigForm } from '@/components/ai-config-form';

/** AI provider and key setup, shown on AI management › Provider (Administration › AI forwards there).
 * Performance AI switches are managed once, on AI management › Agents & features. */
export async function AiProviderScreen({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const source=await requireAdmin(),s={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))};
  const principal=createHash('sha256').update(JSON.stringify([s.tenantId,s.userId,s.personId??null,[...(s.roles??[])].sort(),(s.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])).digest('hex');
  const locale=await getLocale();
  const t = await getTranslations('admin.ai');
  const query=await searchParams,error=Object.prototype.hasOwnProperty.call(query,'error')?t('commandFailed'):undefined;
  const config = await getAiConfigView(s);
  const formKey=createHash('sha256').update(JSON.stringify([principal,locale,config])).digest('hex');
  const envLabel = config.envFallback
    ? config.providers.find((p) => p.provider === config.envFallback!.provider)?.label ?? config.envFallback.provider
    : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p></div>
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

      <AiConfigForm key={formKey} config={config} />
    </div>
  );
}
