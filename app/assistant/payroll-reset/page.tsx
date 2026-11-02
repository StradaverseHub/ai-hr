import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {PayrollResetPanel} from '@/components/assistant/payroll-reset-panel';
import {getBrowserCommandSession} from '@/lib/session';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
export default async function PayrollResetPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.payrollReset');await getBrowserCommandSession();
 const query=await searchParams,resume=z.guid().optional().safeParse(query.review);
 if(!resume.success)return <ReviewShell title={t('title')} description={t('consequence')} width="wide"><p role="alert">{t('unavailable')}</p></ReviewShell>;
 return <ReviewShell title={t('title')} description={t('consequence')} width="wide"><Card className="p-5"><PayrollResetPanel key={randomUUID()} resumeActionId={resume.data}/></Card></ReviewShell>;
}
