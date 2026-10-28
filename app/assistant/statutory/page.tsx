import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleCountryStatutoryActionSection} from '@/components/assistant/module-country-statutory-action-section';
/** GET renders authorized choices/recovery only. Saving requires a separate human-confirmed POST. */
export default async function AssistantStatutoryPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.countryStatutoryActions'),query=await searchParams;return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=country-my" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleCountryStatutoryActionSection resumeActionId={query.review}/></Card></div>;}
