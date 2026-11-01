import {createHash} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell,ReviewAccessDenied} from '@/components/ai-centre/review-shell';
import {GoalApprovalPanel} from '@/components/assistant/goal-approval-panel';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {isGroupAdmin} from '@/lib/authz';
/** Rendering performs no maintenance; each POST repeats current native subject and field authority. */
export default async function AssistantGoalApprovalPage({searchParams}:{searchParams:Promise<{review?:string|string[];goalId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.goalApproval'),query=await searchParams;
 const session=await getSession(),access=await mayUseAssistant(session);
 const identity=createHash('sha256').update(JSON.stringify([session.tenantId,session.userId,session.personId,session.roles,session.grants])).digest('hex');
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant',label:t('back')}} width="wide">
  <Card className="p-5">{access.allowed?<GoalApprovalPanel key={identity} resumeActionId={typeof query.review==='string'?query.review:undefined} initialGoalId={typeof query.goalId==='string'?query.goalId:undefined}/>:<ReviewAccessDenied id="goal-approval-access-heading" reason={access.reason} mayGrant={access.reason==='no_grant'&&isGroupAdmin(session)}/>}</Card>
 </ReviewShell>;
}
