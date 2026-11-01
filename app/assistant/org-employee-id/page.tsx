import {randomUUID} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {EmployeeIdTemplateStatusPanel} from '@/components/assistant/employee-id-template-status-panel';
import {readEmployeeIdTemplateStatusChoices} from '@/core/assistant-actions/employee-id-template-status-review-store';
/** GET composes only current guarded choices. POST owns all human review custody and native writes. */
export default async function EmployeeIdTemplateStatusPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.employeeIdTemplateStatus'),sp=await searchParams,resume=z.guid().optional().safeParse(sp.review);
 const session=await getBrowserCommandSession();
 const choices=await readEmployeeIdTemplateStatusChoices(session);
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant/org',label:t('back')}}><Card className="p-5">{resume.success?<EmployeeIdTemplateStatusPanel key={randomUUID()} initialChoices={choices} resumeActionId={resume.data}/>:<p role="alert">{t('unavailable')}</p>}</Card></ReviewShell>;
}
