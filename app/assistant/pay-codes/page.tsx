import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModulePayComponentActionSection} from '@/components/assistant/module-pay-component-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual catalogue creation. */
export default async function AssistantPayComponentPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.payComponentActions'),query=await searchParams;return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=typed_pay_components" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModulePayComponentActionSection resumeActionId={query.review}/></Card></div>;}
