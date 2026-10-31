import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {DayScheduleCorrectionPanel} from '@/components/assistant/day-schedule-correction-panel';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {isGroupAdmin} from '@/lib/authz';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {z} from 'zod';
/** Rendering performs no correction. Every POST repeats the current native actor/date/effect checks. */
export default async function AssistantDaySchedulePage({searchParams}:{searchParams:Promise<{review?:string|string[];employmentId?:string|string[];date?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.dayScheduleCorrection'),ta=await getTranslations('assistant'),query=await searchParams;
 const session=await getSession(),access=await mayUseAssistant(session),date=z.iso.date().safeParse(query.date);
 return <div className="space-y-5"><Link href="/assistant/attendance" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/>
  <Card className="p-5">{access.allowed?<DayScheduleCorrectionPanel resumeActionId={typeof query.review==='string'?query.review:undefined} initialEmploymentId={typeof query.employmentId==='string'?query.employmentId:undefined} initialDate={date.success?date.data:todayInKualaLumpur()}/>:<section aria-labelledby="day-schedule-access-heading"><h2 id="day-schedule-access-heading" className="text-base font-semibold">{ta('home.accessTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{ta(`denied_${access.reason}`)}</p>{access.reason==='no_grant'&&isGroupAdmin(session)&&<Link href="/control-tower/agents/allowances#user-limits" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{ta('home.grantSelf')}</Link>}</section>}</Card>
 </div>;
}
