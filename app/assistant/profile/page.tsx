import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleProfileActionSection} from '@/components/assistant/module-profile-action-section';
/** GET renders choices only. Explicit authenticated configured-origin POST owns every transition. */
export default async function AssistantProfileRequestPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.profileActions'),query=await searchParams;
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=ess',label:t('back')}}><Card className="p-5"><ModuleProfileActionSection resumeActionId={query.review}/></Card></ReviewShell>;
}
