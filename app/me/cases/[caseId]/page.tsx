import {notFound} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {PrivateCaseError,readOwnPrivateCase} from '@/core/private-cases';
import {Card,PageHeader,StatusBadge,pageWideCls} from '@/components/ui';
export const dynamic='force-dynamic';

/** AI v2 W11 — one of the person's own private cases (ADR-0173): what they wrote and each status change. Opening it is
 * an audited read. Handler notes and who read it are never shown here. Another person's case is not found. */
export default async function MyPrivateCasePage({params,searchParams}:{params:Promise<{caseId:string}>;searchParams:Promise<{notice?:string}>}){
 const {s}=await scopedSession(),{caseId}=await params,sp=await searchParams,t=await getTranslations('privateCases'),locale=await getLocale();
 const detail=await readOwnPrivateCase(s,caseId).catch(error=>{if(error instanceof PrivateCaseError&&error.code==='not_found')notFound();throw error;});
 const date=(value:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(value);
 return <div className={pageWideCls}>
  <PageHeader title={t(`categories.${detail.category}`)} description={t('detail.opened',{date:date(detail.openedAt)})} back={{href:'/me/cases',label:t('detail.back')}}/>
  {sp.notice==='sent'&&<p role="status" className="rounded-md border p-4 text-sm">{t('detail.sent')}</p>}
  <Card className="space-y-5 p-4 sm:p-6">
   <dl className="grid gap-4 text-sm sm:grid-cols-3">
    <div><dt className="text-muted-foreground">{t('detail.status')}</dt><dd className="mt-1"><StatusBadge status={detail.status} label={t(`statuses.${detail.status}`)}/></dd></div>
    <div><dt className="text-muted-foreground">{t('detail.category')}</dt><dd className="mt-1">{t(`categories.${detail.category}`)}</dd></div>
    {detail.companyName&&<div><dt className="text-muted-foreground">{t('detail.company')}</dt><dd className="mt-1">{detail.companyName}</dd></div>}
   </dl>
   <section aria-labelledby="private-case-text" className="space-y-2"><h2 id="private-case-text" className="text-sm font-semibold">{t('detail.text')}</h2>
    <p data-private-case-text className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{detail.text}</p></section>
  </Card>
  <Card className="space-y-3 p-4 sm:p-6"><h2 className="text-sm font-semibold">{t('detail.history')}</h2>
   <ol className="space-y-2 text-sm">{detail.history.map((step,index)=><li key={index}>{t('detail.step',{status:t(`statuses.${step.status}`),date:date(step.at)})}</li>)}</ol></Card>
 </div>;
}
