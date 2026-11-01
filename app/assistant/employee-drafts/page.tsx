import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell,ReviewAccessDenied} from '@/components/ai-centre/review-shell';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {EmployeeDraftActivationPanel} from '@/components/assistant/employee-draft-activation-panel';
export default async function EmployeeDraftActivationPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.employeeDraftActivation'),q=await searchParams,session=await getSession(),access=await mayUseAssistant(session);
 return <ReviewShell title={t('title')} description={t('description')} width="wide"><Card className="p-5">{access.allowed?<EmployeeDraftActivationPanel resumeActionId={typeof q.review==='string'?q.review:undefined}/>:<ReviewAccessDenied id="employee-draft-activation-access-heading" reason={access.reason} mayGrant={false}/>}</Card></ReviewShell>;
}
