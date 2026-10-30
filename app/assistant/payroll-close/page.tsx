import Link from 'next/link';
import {PayrollRecoveryHandoffs} from '@/components/assistant/payroll-recovery-handoffs';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModulePayrollCloseActionSection} from '@/components/assistant/module-payroll-close-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual native Payroll close. */
export default async function AssistantPayrollClosePage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const reopen=await getTranslations('assistant.workspace.payrollReopen');const t=await getTranslations('assistant.workspace.payrollCloseActions'),query=await searchParams;return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=payroll" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModulePayrollCloseActionSection resumeActionId={query.review}/></Card><Link href="/assistant/payroll-reopen" className="inline-flex min-h-11 items-center text-sm underline">{reopen('title')}</Link><Card className="p-5"><PayrollRecoveryHandoffs/></Card></div>;}
