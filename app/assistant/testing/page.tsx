import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleTestingActionSection} from '@/components/assistant/module-testing-action-section';
/** GET is choice composition only; each explicit human transition uses the fixed guarded POST. */
export default async function AssistantTestingObservationPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.testingActions'),query=await searchParams;return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=system_testing" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleTestingActionSection resumeActionId={query.review}/></Card></div>;
}
