import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleKnowledgeActionSection} from '@/components/assistant/module-knowledge-action-section';
/** GET renders human input and fresh author availability only. Publication requires explicit POST. */
export default async function AssistantKnowledgeArticlePage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.knowledgeActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=knowledge_base',label:t('back')}}><Card className="p-5"><ModuleKnowledgeActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
