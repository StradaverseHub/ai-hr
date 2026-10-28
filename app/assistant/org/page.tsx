import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleOrgActionSection} from '@/components/assistant/module-org-action-section';
/** GET only composes guarded human input; structural effects remain explicit authenticated POST. */
export default async function AssistantOrgReportingPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.orgActions'),query=await searchParams;
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=org" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleOrgActionSection resumeActionId={query.review}/></Card></div>;
}
