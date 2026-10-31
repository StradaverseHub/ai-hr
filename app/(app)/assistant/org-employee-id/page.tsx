import {randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {Card,PageHeader} from '@/components/ui';
import {EmployeeIdTemplateStatusPanel} from '@/components/assistant/employee-id-template-status-panel';
import {readEmployeeIdTemplateStatusChoices} from '@/core/assistant-actions/employee-id-template-status-review-store';
/** GET composes only current guarded choices. POST owns all human review custody and native writes. */
export default async function EmployeeIdTemplateStatusPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.employeeIdTemplateStatus'),sp=await searchParams,resume=z.guid().optional().safeParse(sp.review);
 const session=await getBrowserCommandSession();
 const choices=await readEmployeeIdTemplateStatusChoices(session);
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant/org" className="inline-flex min-h-11 items-center underline">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5">{resume.success?<EmployeeIdTemplateStatusPanel key={randomUUID()} initialChoices={choices} resumeActionId={resume.data}/>:<p role="alert">{t('unavailable')}</p>}</Card></div>;
}
