import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {EmployeeDraftActivationPanel} from '@/components/assistant/employee-draft-activation-panel';
export default async function EmployeeDraftActivationPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.employeeDraftActivation'),ta=await getTranslations('assistant'),q=await searchParams,session=await getSession(),access=await mayUseAssistant(session);
 return <div className="mx-auto max-w-4xl space-y-5"><PageHeader title={t('title')} description={t('description')}/><Card className="p-5">{access.allowed?<EmployeeDraftActivationPanel resumeActionId={typeof q.review==='string'?q.review:undefined}/>:<p>{ta('denied_'+access.reason)}</p>}</Card></div>;
}
