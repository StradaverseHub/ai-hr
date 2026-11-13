'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Field,inputCls} from '@/components/ui';
import {ReviewBeforeSavingDialog} from '@/app/admin/rewards/review-before-saving';
import {previewOffcycleYearAction,saveOffcycleYearAction,type OffcycleReview} from './actions';

/** Opening the off-cycle year, or changing the mid-year window, shows "Review before saving" and saves directly. */
export function OffcycleYearForm({cycleId,revision,canOpen,midyearFrom,midyearTo}:{cycleId:string;revision:number;canOpen:boolean;midyearFrom:string|null;midyearTo:string|null}){
 const t=useTranslations('rewardDashboard'),router=useRouter();
 const [from,setFrom]=useState(midyearFrom??''),[to,setTo]=useState(midyearTo??'');
 const [review,setReview]=useState<OffcycleReview|null>(null),[error,setError]=useState(''),[pending,startTransition]=useTransition();
 const input={cycleId,expectedRevision:revision,midyearFrom:from||null,midyearTo:to||null};
 const open=revision>0;
 const preview=()=>startTransition(async()=>{setError('');const result=await previewOffcycleYearAction(input);if(result.review)setReview(result.review);else setError(result.error);});
 const confirm=(reason:string,digest:string)=>startTransition(async()=>{const result=await saveOffcycleYearAction(input,reason,digest);
  if(result.ok){setReview(null);router.refresh();}else{setError(result.error);if(result.review)setReview(result.review);}});
 return <div className="space-y-3">
  <div className="grid gap-3 sm:grid-cols-2">
   <Field label={t('offcycle.windowFrom')}><input type="date" value={from} onChange={e=>setFrom(e.target.value)} disabled={!open&&!canOpen} className={inputCls}/></Field>
   <Field label={t('offcycle.windowTo')}><input type="date" value={to} onChange={e=>setTo(e.target.value)} disabled={!open&&!canOpen} className={inputCls}/></Field>
  </div>
  {error&&!review&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Button type="button" onClick={preview} disabled={pending||!open&&!canOpen}>{t(open?'offcycle.saveWindow':'offcycle.openYear')}</Button>
  <ReviewBeforeSavingDialog open={!!review} summary={review?.summary??null} digest={review?.digest??null} error={review?error:undefined} pending={pending} submitLabel={t(open?'offcycle.saveWindow':'offcycle.openYear')} onClose={()=>setReview(null)} onConfirm={confirm}/>
 </div>;
}
