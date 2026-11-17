'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Field,inputCls} from '@/components/ui';
import {useUnsavedChangesGuard} from '@/components/ui/unsaved-changes';
import {ReviewBeforeSavingDialog} from '../review-before-saving';
import type {RewardConfigSummary} from '@/packs/rewards/config-change-model';
import {shiftRewardYearSettings,type RewardYearSettings,type RewardYearInput} from '@/packs/rewards/review-plans-model';
import {previewYearAction,createYearAction} from './actions';
const dates=['effectiveFrom','joinedBefore','confirmedBy','activeAsOf','blockedFrom','blockedTo','snapshotDate'] as const;
export function NewRewardYear({year,settings,canCreate}:{year:number;settings:RewardYearSettings;canCreate:boolean}){
 const t=useTranslations('rewardsReviewPlans'),router=useRouter();
 const [open,setOpen]=useState(false),[value,setValue]=useState<RewardYearInput>({year,settings}),[error,setError]=useState(''),[pending,start]=useTransition();
 const [review,setReview]=useState<{summary:RewardConfigSummary;digest:string}|null>(null);
 useUnsavedChangesGuard(open,t('unsaved'));
 const preview=()=>start(async()=>{setError('');const r=await previewYearAction(value);if(r.ok)setReview(r.review);else setError(r.error);});
 const save=(reason:string,digest:string)=>start(async()=>{const r=await createYearAction(value,digest,reason);if(r.ok){setReview(null);setOpen(false);router.push('/admin/rewards/review-plans?year='+value.year);router.refresh();}else setError(r.error);});
 if(!canCreate)return null;
 return<section className="space-y-4"><Button type="button" variant={open?'outline':'default'} onClick={()=>setOpen(!open)} aria-expanded={open}>{t('newYear')}</Button>
 {open&&<form className="space-y-4 rounded-lg border border-border p-4" onSubmit={e=>{e.preventDefault();preview();}}><h2 className="font-semibold">{t('newYear')}</h2><p className="max-w-3xl text-sm text-muted-foreground">{t('yearHelp')}</p><fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Field label={t('year')}><input type="number" min={2000} max={2200} required className={inputCls} value={value.year} onChange={e=>{const y=Number(e.target.value);setValue(current=>({...current,year:y,settings:Number.isInteger(y)&&y>=2000&&y<=2200?shiftRewardYearSettings(settings,y-year):current.settings}));}}/></Field>{dates.map(key=><Field key={key} label={t('dates.'+key)}><input type="date" required className={inputCls} value={value.settings[key]} onChange={e=>setValue(current=>({...current,settings:{...current.settings,[key]:e.target.value}}))}/></Field>)}</fieldset>
 {error&&!review&&<p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex gap-2"><Button disabled={pending} aria-busy={pending}>{t('previewYear')}</Button><Button type="button" variant="outline" disabled={pending} onClick={()=>setOpen(false)}>{t('cancel')}</Button></div></form>}
 <ReviewBeforeSavingDialog open={!!review} summary={review?.summary??null} digest={review?.digest??null} onClose={()=>setReview(null)} onConfirm={save} pending={pending} error={error} submitLabel={t('createYear')}/>
 </section>;
}
