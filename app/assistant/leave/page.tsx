import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {OwnLeaveCommandSection} from '@/components/assistant/own-leave-command-section';
import {OwnLeaveChangeSection} from '@/components/assistant/own-leave-change-section';

/** GET renders current own choices/review UI only. Canonical submission is a separate explicit POST. */
export default async function OwnLeavePage({searchParams}:{searchParams:Promise<{review?:string|string[];flow?:string|string[];action?:string|string[]}>}){
 const t=await getTranslations('ownLeaveReview.workflow'),c=await getTranslations('ownLeaveChange'),query=await searchParams,change=query.flow==='change';
 return <div className="mx-auto max-w-3xl space-y-5">
  <Link href="/assistant?job=leave" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('back')}</Link>
  <PageHeader title={change?c('title'):t('title')} description={change?c('description'):t('description')}/>
  {/* ADR-0151 wave 1: applying and changing a pending request are separate human flows. */}
  <nav aria-label={c('flowLabel')} className="flex flex-wrap gap-3 text-sm">
   <Link href="/assistant/leave" aria-current={!change?'page':undefined} className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{c('applyFlow')}</Link>
   <Link href="/assistant/leave?flow=change" aria-current={change?'page':undefined} className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{c('changeFlow')}</Link>
  </nav>
  <Card className="p-5">{change?<OwnLeaveChangeSection resumeActionId={query.review} resumeAction={query.action}/>:<OwnLeaveCommandSection resumeActionId={query.review}/>}</Card>
 </div>;
}
