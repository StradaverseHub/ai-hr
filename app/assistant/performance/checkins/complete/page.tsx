import {createHash} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell,ReviewAccessDenied} from '@/components/ai-centre/review-shell';
import {CheckInCompletionPanel} from '@/components/assistant/checkin-completion-panel';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {isGroupAdmin} from '@/lib/authz';
/** Rendering performs no maintenance; each POST repeats current native subject and field authority. */
export default async function AssistantCheckInCompletionPage({searchParams}:{searchParams:Promise<{review?:string|string[];checkinId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.checkInCompletion'),query=await searchParams;
 const session=await getSession(),access=await mayUseAssistant(session);
 const identity=createHash('sha256').update(JSON.stringify([session.tenantId,session.userId,session.personId,session.roles,session.grants])).digest('hex');
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant',label:t('back')}} width="wide">
  <Card className="p-5">{access.allowed?<CheckInCompletionPanel key={identity} resumeActionId={typeof query.review==='string'?query.review:undefined} initialCheckinId={typeof query.checkinId==='string'?query.checkinId:undefined}/>:<ReviewAccessDenied id="checkin-completion-access-heading" reason={access.reason} mayGrant={access.reason==='no_grant'&&isGroupAdmin(session)}/>}</Card>
 </ReviewShell>;
}
