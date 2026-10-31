import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleKnowledgeActionSection} from '@/components/assistant/module-knowledge-action-section';
/** GET renders human input and fresh author availability only. Publication requires explicit POST. */
export default async function AssistantKnowledgeArticlePage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.knowledgeActions'),query=await searchParams;return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=knowledge_base" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleKnowledgeActionSection resumeActionId={query.review}/></Card></div>;}
