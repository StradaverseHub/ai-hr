import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleMultiCycleRunActionSection} from '@/components/assistant/module-multi-cycle-run-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST creates only the actual native additional-run draft. */
export default async function AssistantMultiCycleRunPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.multiCycleRunActions'),query=await searchParams;return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=multi_cycle_payroll" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleMultiCycleRunActionSection resumeActionId={query.review}/></Card></div>;}
