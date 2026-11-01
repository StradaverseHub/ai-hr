import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleNotificationActionSection} from '@/components/assistant/module-notification-action-section';
/** GET renders one guarded Notifications specialist human-action path. The fixed authenticated,
 * origin-checked POST owner alone may save after a separate explicit human confirmation. */
export default async function AssistantNotificationPreferencesPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.moduleActions'),query=await searchParams;
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=notifications',label:t('back')}}><Card className="p-5"><ModuleNotificationActionSection resumeActionId={query.review}/></Card></ReviewShell>;
}
