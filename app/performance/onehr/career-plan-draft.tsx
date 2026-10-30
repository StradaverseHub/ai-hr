'use client';
import { useRef,useState,useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button,inputCls } from '@/components/ui';
import { careerPlanDraftAction,applyCareerPlanDraftAction } from '../onehr-actions';
import type { suggestAssessmentCareerPlan } from '@/packs/performance/service';
type Draft=Awaited<ReturnType<typeof suggestAssessmentCareerPlan>>;

export function CareerPlanDraft({reviewId,savedTargetId,initialQuota}:{reviewId:string;savedTargetId:string|null;initialQuota?:{remaining:number;limit:number}|null}){
 const t=useTranslations('onehr.careerDraft'),goalsT=useTranslations('onehr.developmentSuggestions'),router=useRouter(),root=useRef<HTMLDivElement>(null);
 const [result,setResult]=useState<Draft|null>(null),[kept,setKept]=useState<number[]>([]),[long,setLong]=useState(''),[keepLong,setKeepLong]=useState(false),[error,setError]=useState(''),[pending,start]=useTransition();
 const quota=result??initialQuota;
 const generate=()=>{
  const form=root.current?.closest('form');if(!form)return;const data=new FormData(form);
  if((String(data.get('targetProfileId')??'')||null)!==savedTargetId){setError(t('saveDirection'));return;}
  // Capture only explicit human words from the existing native form. Empty input nominates no aspiration.
  const aspirationLong=String(data.get('aspirationLong')??'').trim();
  setError('');start(async()=>{try{const response=await (aspirationLong?careerPlanDraftAction(reviewId,{aspirationLong}):careerPlanDraftAction(reviewId));if('error' in response){setError(response.error??goalsT('unavailable'));return;}setResult(response);setKept(response.goals.map((_,i)=>i));setLong(response.aspirationLong);setKeepLong(!!response.aspirationLong&&!String(new FormData(form).get('aspirationLong')??'').trim());}catch{setError(goalsT('unavailable'));}});
 };
 const apply=()=>{
  const form=root.current?.closest('form');if(!form||!result)return;const data=new FormData(form);
  setError('');start(async()=>{try{const response=await applyCareerPlanDraftAction(data,result.goals.filter((_,i)=>kept.includes(i)),keepLong?long:'',result.sourceDigest);if('error' in response){setError(response.error??goalsT('unavailable'));return;}setResult(null);setKept([]);setLong('');setKeepLong(false);router.refresh();}catch{setError(goalsT('unavailable'));}});
 };
 return <div ref={root} className="space-y-3 border-y border-border py-4">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{t('title')}</h3><p className="mt-1 max-w-prose text-xs text-muted-foreground">{t('help')}</p></div><Button type="button" variant="secondary" onClick={generate} disabled={pending||quota?.remaining===0}>{pending?goalsT('working'):t('generate')}</Button></div>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {quota&&<p role="status" className="text-xs text-muted-foreground">{goalsT('quota',{remaining:quota.remaining,limit:quota.limit})}</p>}
  {result&&(result.empty?<p className="text-sm">{t('empty')}</p>:<>
   <p className="text-sm text-muted-foreground">{t('preview')}</p>
   <ul className="divide-y divide-border">{result.goals.map((goal,index)=><li key={index} className="space-y-2 py-3"><label className="flex min-h-11 items-center gap-2 text-sm font-medium"><input type="checkbox" disabled={pending} checked={kept.includes(index)} onChange={e=>setKept(e.target.checked?[...kept,index]:kept.filter(i=>i!==index))}/>{goal.area}</label><p className="text-xs text-muted-foreground">{goalsT('basedOn')}: {goal.itemIds.map(id=>result.pool.find(i=>i.id===id)?.detail).filter(Boolean).join(' · ')}</p><dl className="space-y-2 text-sm">{(['onJob','fromOthers','formalLearning'] as const).map(field=><div key={field}><dt className="font-medium">{goalsT(field)}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{goal[field]||goalsT('noAction')}</dd></div>)}</dl></li>)}</ul>
   {result.aspirationLong&&<div className="space-y-2"><label className="flex min-h-11 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={keepLong} disabled={pending} onChange={e=>setKeepLong(e.target.checked)}/>{t('keepAspiration')}</label><textarea aria-label={t('keepAspiration')} maxLength={4000} value={long} onChange={e=>setLong(e.target.value)} disabled={pending} className={inputCls}/></div>}
   <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="secondary" disabled={pending} onClick={()=>{setResult(null);setKept([]);setLong('');setKeepLong(false);}}>{goalsT('discard')}</Button><Button type="button" disabled={pending||!kept.length&&(!keepLong||!long.trim())} onClick={apply}>{t('keep')}</Button></div>
  </>)}
 </div>;
}
