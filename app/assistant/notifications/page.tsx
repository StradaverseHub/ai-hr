import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleNotificationActionSection} from '@/components/assistant/module-notification-action-section';
/** GET renders one guarded Notifications specialist human-action path. The fixed authenticated,
 * origin-checked POST owner alone may save after a separate explicit human confirmation. */
export default async function AssistantNotificationPreferencesPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.moduleActions'),query=await searchParams;
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=notifications" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleNotificationActionSection resumeActionId={query.review}/></Card></div>;
}
