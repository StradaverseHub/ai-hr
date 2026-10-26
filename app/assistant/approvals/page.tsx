import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleAssignedLeaveActionSection} from '@/components/assistant/module-assigned-leave-action-section';
/** GET only renders assigned metadata and recovery controls. A separate human-confirmed POST records a decision. */
export default async function AssistantAssignedLeaveDecisionPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.approvalActions'),query=await searchParams;return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=approvals" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleAssignedLeaveActionSection resumeActionId={query.review}/></Card></div>;}
