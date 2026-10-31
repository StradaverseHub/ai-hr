import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {CompensationMaintenancePanel} from '@/components/assistant/compensation-maintenance-panel';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {isGroupAdmin} from '@/lib/authz';
/** Rendering performs no maintenance; each POST repeats current native subject and field authority. */
export default async function AssistantCompensationPage({searchParams}:{searchParams:Promise<{review?:string|string[];employmentId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.compensationMaintenance'),ta=await getTranslations('assistant'),query=await searchParams;
 const session=await getSession(),access=await mayUseAssistant(session);
 return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/>
  <Card className="p-5">{access.allowed?<CompensationMaintenancePanel resumeActionId={typeof query.review==='string'?query.review:undefined} initialEmploymentId={typeof query.employmentId==='string'?query.employmentId:undefined}/>:<section aria-labelledby="compensation-access-heading"><h2 id="compensation-access-heading" className="text-base font-semibold">{ta('home.accessTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{ta(`denied_${access.reason}`)}</p>{access.reason==='no_grant'&&isGroupAdmin(session)&&<Link href="/control-tower/agents/allowances#user-limits" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{ta('home.grantSelf')}</Link>}</section>}</Card>
 </div>;
}
