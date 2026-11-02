import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleToilRequestActionSection} from '@/components/assistant/module-toil-request-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST requests leave. */
export default async function AssistantToilRequestPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.toilActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=toil',label:t('back')}} width="wide"><Card className="p-5"><ModuleToilRequestActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
