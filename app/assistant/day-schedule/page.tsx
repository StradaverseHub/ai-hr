import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell,ReviewAccessDenied} from '@/components/ai-centre/review-shell';
import {DayScheduleCorrectionPanel} from '@/components/assistant/day-schedule-correction-panel';
import {getSession} from '@/lib/session';
import {mayUseAssistant} from '@/core/assistant-grant';
import {isGroupAdmin} from '@/lib/authz';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {z} from 'zod';
/** Rendering performs no correction. Every POST repeats the current native actor/date/effect checks. */
export default async function AssistantDaySchedulePage({searchParams}:{searchParams:Promise<{review?:string|string[];employmentId?:string|string[];date?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.dayScheduleCorrection'),query=await searchParams;
 const session=await getSession(),access=await mayUseAssistant(session),date=z.iso.date().safeParse(query.date);
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant/attendance',label:t('back')}}>
  <Card className="p-5">{access.allowed?<DayScheduleCorrectionPanel resumeActionId={typeof query.review==='string'?query.review:undefined} initialEmploymentId={typeof query.employmentId==='string'?query.employmentId:undefined} initialDate={date.success?date.data:todayInKualaLumpur()}/>:<ReviewAccessDenied id="day-schedule-access-heading" reason={access.reason} mayGrant={access.reason==='no_grant'&&isGroupAdmin(session)}/>}</Card>
 </ReviewShell>;
}
