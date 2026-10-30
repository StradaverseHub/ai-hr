'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {NativeInsightOutline} from './native-insight-outline';
import {assessmentPotentialInsightAction} from '../onehr-actions';
import type {getAssessmentPotentialInsight} from '@/packs/performance/service';
export function PotentialInsight({reviewId,sessionId,initialOpen=false}:{reviewId:string;sessionId:string;initialOpen?:boolean}){
 const t=useTranslations('onehr'),[result,setResult]=useState<Awaited<ReturnType<typeof getAssessmentPotentialInsight>>|null>(null),[error,setError]=useState(''),[busy,start]=useTransition(),sequence=useRef(0);
 const load=(generate:boolean)=>{const request=++sequence.current;setResult(null);setError('');start(async()=>{try{const response=await assessmentPotentialInsightAction(reviewId,sessionId,generate);if(request!==sequence.current)return;if('error' in response)setError(response.error);else setResult(response);}catch{if(request===sequence.current)setError(t('insight.unavailable'));}});};
 const details=useRef<HTMLDetailsElement>(null);useEffect(()=>{if(initialOpen&&details.current)details.current.open=true;},[initialOpen]);
 return <details ref={details} className="rounded-lg border border-border" onToggle={e=>{if(e.currentTarget.open)load(false);else{sequence.current++;setResult(null);setError('');}}}>
  <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">{t('potentialInsight.title')}</summary>
  <div className="space-y-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">{t('potentialInsight.help')}</p>
   {busy&&<p role="status">{t('insight.working')}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {!busy&&!error&&(!result||result.pending)&&<Button type="button" variant="secondary" onClick={()=>load(true)}>{t('insight.generate')}</Button>}
   {!busy&&result?.data&&<><p className="text-sm leading-relaxed">{result.data.paragraph}</p><NativeInsightOutline data={result.data}/></>}
  </div>
 </details>;
}
