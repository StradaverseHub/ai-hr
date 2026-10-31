import Link from 'next/link';
import {createHash} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {CheckInCompletionPanel} from '@/components/assistant/checkin-completion-panel';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {isGroupAdmin} from '@/lib/authz';
/** Rendering performs no maintenance; each POST repeats current native subject and field authority. */
export default async function AssistantCheckInCompletionPage({searchParams}:{searchParams:Promise<{review?:string|string[];checkinId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.checkInCompletion'),ta=await getTranslations('assistant'),query=await searchParams;
 const session=await getSession(),access=await mayUseAssistant(session);
 const identity=createHash('sha256').update(JSON.stringify([session.tenantId,session.userId,session.personId,session.roles,session.grants])).digest('hex');
 return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/>
  <Card className="p-5">{access.allowed?<CheckInCompletionPanel key={identity} resumeActionId={typeof query.review==='string'?query.review:undefined} initialCheckinId={typeof query.checkinId==='string'?query.checkinId:undefined}/>:<section aria-labelledby="checkin-completion-access-heading"><h2 id="checkin-completion-access-heading" className="text-base font-semibold">{ta('home.accessTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{ta(`denied_${access.reason}`)}</p>{access.reason==='no_grant'&&isGroupAdmin(session)&&<Link href="/control-tower/agents/allowances#user-limits" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{ta('home.grantSelf')}</Link>}</section>}</Card>
 </div>;
}
