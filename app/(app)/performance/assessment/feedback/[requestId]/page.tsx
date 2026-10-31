import { FeedbackView } from '../../../onehr/feedback-view';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { getOnehrFeedback } from '@/packs/performance/service';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { onehrFeedbackAction } from '../../../onehr-actions';
export default async function OnehrFeedbackPage({params,searchParams}:{params:Promise<{requestId:string}>;searchParams:Promise<{error?:string}>}){
  const {s}=await scopedSession();const {requestId}=await params,{error}=await searchParams,t=await getTranslations('onehr');const v=await getOnehrFeedback(s,requestId);
  return <div className="mx-auto max-w-3xl space-y-5"><PageHeader back={{href:'/me/performance',label:t('back')}} title={`${t('feedback360')} · ${v.subject}`} description={t('anonymousHelp')}/><ErrorBanner message={error}/><Card><FeedbackView v={v}/></Card></div>;
}
