import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {OwnLeaveCommandSection} from '@/components/assistant/own-leave-command-section';

/** GET renders current own choices/review UI only. Canonical submission is a separate explicit POST. */
export default async function OwnLeavePage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('ownLeaveReview.workflow'),query=await searchParams;
 return <div className="mx-auto max-w-3xl space-y-5">
  <Link href="/assistant" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('back')}</Link>
  <PageHeader title={t('title')} description={t('description')}/>
  <Card className="p-5"><OwnLeaveCommandSection resumeActionId={query.review}/></Card>
 </div>;
}
