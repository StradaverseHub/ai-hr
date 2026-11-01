import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleLifecycleAckActionSection} from '@/components/assistant/module-lifecycle-ack-action-section';
/** GET never acknowledges equipment; a separately confirmed authenticated POST owns that effect. */
export default async function AssistantLifecycleAcknowledgementPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.lifecycleActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=lifecycle',label:t('back')}}><Card className="p-5"><ModuleLifecycleAckActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
