import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {EmployeeDraftDiscardPanel} from '@/components/assistant/employee-draft-discard-panel';
/** Rendering performs no draft mutation. Every command repeats current native authority. */
export default async function EmployeeDraftDiscardPage({searchParams}:{searchParams:Promise<{review?:string|string[];draftId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.employeeDraftDiscard'),ta=await getTranslations('assistant');
 const query=await searchParams,session=await getSession(),access=await mayUseAssistant(session);
 return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5">{access.allowed?<EmployeeDraftDiscardPanel resumeActionId={typeof query.review==='string'?query.review:undefined} initialDraftId={typeof query.draftId==='string'?query.draftId:undefined}/>:<p>{ta('denied_'+access.reason)}</p>}</Card></div>;
}
