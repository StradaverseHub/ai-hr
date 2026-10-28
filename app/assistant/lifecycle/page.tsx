import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleLifecycleAckActionSection} from '@/components/assistant/module-lifecycle-ack-action-section';
/** GET never acknowledges equipment; a separately confirmed authenticated POST owns that effect. */
export default async function AssistantLifecycleAcknowledgementPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.lifecycleActions'),query=await searchParams;return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=lifecycle" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleLifecycleAckActionSection resumeActionId={query.review}/></Card></div>;}
