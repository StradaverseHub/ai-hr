import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell,ReviewAccessDenied} from '@/components/ai-centre/review-shell';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {EmployeeDraftDiscardPanel} from '@/components/assistant/employee-draft-discard-panel';
/** Rendering performs no draft mutation. Every command repeats current native authority. */
export default async function EmployeeDraftDiscardPage({searchParams}:{searchParams:Promise<{review?:string|string[];draftId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.employeeDraftDiscard');
 const query=await searchParams,session=await getSession(),access=await mayUseAssistant(session);
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant',label:t('back')}} width="wide"><Card className="p-5">{access.allowed?<EmployeeDraftDiscardPanel resumeActionId={typeof query.review==='string'?query.review:undefined} initialDraftId={typeof query.draftId==='string'?query.draftId:undefined}/>:<ReviewAccessDenied id="employee-draft-discard-access-heading" reason={access.reason} mayGrant={false}/>}</Card></ReviewShell>;
}
