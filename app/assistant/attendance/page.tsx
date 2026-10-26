import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleAttendanceActionSection} from '@/components/assistant/module-attendance-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual own correction for native approval. */
export default async function AssistantAttendanceCorrectionPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.attendanceActions'),query=await searchParams;return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=attendance" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleAttendanceActionSection resumeActionId={query.review}/></Card></div>;}
