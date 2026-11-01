import Link from 'next/link';
import {PerformanceNativeHandoffs} from '@/components/assistant/performance-native-handoffs';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModulePerformanceActionSection} from '@/components/assistant/module-performance-action-section';
/** GET is choice composition only; each explicit human transition uses the fixed guarded POST. */
export default async function AssistantPerformanceAcknowledgementsPage({searchParams}:{searchParams:Promise<{review?:string|string[];engine?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.performanceActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=performance',label:t('back')}}><Card className="p-5"><ModulePerformanceActionSection resumeActionId={query.review} resumeEngine={query.engine}/></Card><Card className="p-5"><Link href="/assistant/performance/checkins" className="inline-flex min-h-11 items-center text-sm underline">{(await getTranslations('assistant.workspace.checkInCancellation'))('title')}</Link><Link href="/assistant/performance/checkins/complete" className="inline-flex min-h-11 items-center text-sm underline">{(await getTranslations('assistant.workspace.checkInCompletion'))('title')}</Link><Link href="/assistant/performance/checkins/schedule" className="inline-flex min-h-11 items-center text-sm underline">{(await getTranslations('assistant.workspace.checkInScheduling'))('title')}</Link><Link href="/assistant/performance/goals" className="inline-flex min-h-11 items-center text-sm underline">{(await getTranslations('assistant.workspace.goalApproval'))('title')}</Link><PerformanceNativeHandoffs/></Card></ReviewShell>;
}
