import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {HrPreparedPanel} from '@/components/assistant/hr-prepared-panel';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION,HR_LEAVE_CREDIT_ACTION} from '@/lib/assistant-actions/hr-prepared-contract';
/** GET only renders the flow and recovery controls. ADR-0151 (amendment 2026-10-29): HR-prepared changes to
 * another employee's record (?flow=leave|movement|credit). Choices, preparation and confirmation go through the same
 * guarded POST as every other Assistant action, which re-checks the administrator's authority each time. */
const FLOWS={leave:{action:HR_LEAVE_ADJUSTMENT_ACTION,kind:'leave'},movement:{action:HR_MOVEMENT_TRANSFER_ACTION,kind:'movement'},credit:{action:HR_LEAVE_CREDIT_ACTION,kind:'credit'}} as const;
export default async function AssistantHrActionsPage({searchParams}:{searchParams:Promise<{review?:string|string[];flow?:string|string[];employmentId?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.hrActions'),query=await searchParams;
 const flow=typeof query.flow==='string'&&Object.hasOwn(FLOWS,query.flow)?FLOWS[query.flow as keyof typeof FLOWS]:FLOWS.leave;
 const link='inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',current=(name:string)=>flow.kind===name?'page' as const:undefined;
 return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t(`${flow.kind}.title`)} description={t(`${flow.kind}.description`)}/>
  <nav aria-label={t('flowLabel')} className="flex flex-wrap gap-3 text-sm"><Link href="/assistant/hr?flow=leave" aria-current={current('leave')} className={link}>{t('leaveFlow')}</Link><Link href="/assistant/hr?flow=movement" aria-current={current('movement')} className={link}>{t('movementFlow')}</Link><Link href="/assistant/hr?flow=credit" aria-current={current('credit')} className={link}>{t('creditFlow')}</Link></nav>
  <Card className="p-5"><HrPreparedPanel key={flow.action} action={flow.action} resumeActionId={typeof query.review==='string'?query.review:undefined} initialEmploymentId={typeof query.employmentId==='string'?query.employmentId:undefined}/></Card></div>;
}
