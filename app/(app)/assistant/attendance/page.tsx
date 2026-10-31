import {AttendanceNativeWorkflows} from '@/components/assistant/attendance-native-workflows';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleAttendanceActionSection} from '@/components/assistant/module-attendance-action-section';
import {OwnOvertimeRequestPanel} from '@/components/assistant/own-overtime-request-panel';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual own correction for native approval.
 * ADR-0151 wave 1b: an own overtime request is a separate human flow (?flow=overtime); its choices load through the same guarded POST. */
export default async function AssistantAttendanceCorrectionPage({searchParams}:{searchParams:Promise<{review?:string|string[];flow?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.attendanceActions'),o=await getTranslations('assistant.workspace.overtimeActions'),query=await searchParams,overtime=query.flow==='overtime';
 const link='inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
 return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=attendance" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={overtime?o('title'):t('title')} description={overtime?o('description'):t('description')}/>
  <nav aria-label={o('flowLabel')} className="flex flex-wrap gap-3 text-sm"><Link href="/assistant/attendance" aria-current={!overtime?'page':undefined} className={link}>{o('correctionFlow')}</Link><Link href="/assistant/attendance?flow=overtime" aria-current={overtime?'page':undefined} className={link}>{o('overtimeFlow')}</Link></nav>
  <Card className="p-5">{overtime?<OwnOvertimeRequestPanel resumeActionId={typeof query.review==='string'?query.review:undefined}/>:<ModuleAttendanceActionSection resumeActionId={query.review}/>}</Card><AttendanceNativeWorkflows/></div>;
}
