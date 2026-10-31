import {getTranslations} from 'next-intl/server';
import {PageHeader,Card} from '@/components/ui';
import {PayrollResetPanel} from '@/components/assistant/payroll-reset-panel';
import {getBrowserCommandSession} from '@/lib/session';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
export default async function PayrollResetPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.payrollReset');await getBrowserCommandSession();
 const query=await searchParams,resume=z.guid().optional().safeParse(query.review);
 if(!resume.success)return <p role="alert">{t('unavailable')}</p>;
 return <div className="mx-auto max-w-4xl space-y-5"><PageHeader title={t('title')} description={t('consequence')}/><Card className="p-5"><PayrollResetPanel key={randomUUID()} resumeActionId={resume.data}/></Card></div>;
}
