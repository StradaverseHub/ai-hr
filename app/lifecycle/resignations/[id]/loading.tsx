import {getTranslations} from 'next-intl/server';
export default async function Loading(){const t=await getTranslations('resignationJourney');return <div className="mx-auto max-w-5xl animate-pulse space-y-5" role="status" aria-label={t('loading')}><div className="h-8 w-60 rounded bg-muted"/><div className="h-96 rounded-xl bg-muted"/><span className="sr-only">{t('loading')}</span></div>;}
