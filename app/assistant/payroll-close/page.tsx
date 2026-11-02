import Link from 'next/link';
import {PayrollRecoveryHandoffs} from '@/components/assistant/payroll-recovery-handoffs';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModulePayrollCloseActionSection} from '@/components/assistant/module-payroll-close-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual native Payroll close. */
export default async function AssistantPayrollClosePage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const reset=await getTranslations('assistant.workspace.payrollReset'),reopen=await getTranslations('assistant.workspace.payrollReopen');const t=await getTranslations('assistant.workspace.payrollCloseActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=payroll',label:t('back')}} width="wide"><Card className="p-5"><ModulePayrollCloseActionSection resumeActionId={query.review}/></Card><Link href="/assistant/payroll-reopen" className="inline-flex min-h-11 items-center text-sm underline">{reopen('title')}</Link><Link href="/assistant/payroll-reset" className="inline-flex min-h-11 items-center text-sm underline">{reset('title')}</Link><Card className="p-5"><PayrollRecoveryHandoffs/></Card></ReviewShell>;}
