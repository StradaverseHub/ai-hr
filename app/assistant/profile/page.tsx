import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleProfileActionSection} from '@/components/assistant/module-profile-action-section';
/** GET renders choices only. Explicit authenticated configured-origin POST owns every transition. */
export default async function AssistantProfileRequestPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.profileActions'),query=await searchParams;
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=ess" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleProfileActionSection resumeActionId={query.review}/></Card></div>;
}
