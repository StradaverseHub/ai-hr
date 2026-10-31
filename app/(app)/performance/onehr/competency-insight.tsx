'use client';
import {useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {assessmentCompetencyInsightAction} from '../onehr-actions';
import type {getAssessmentCompetencyInsight} from '@/packs/performance/service';
export function CompetencyInsight({reviewId}:{reviewId:string}){
 const t=useTranslations('onehr'),[result,setResult]=useState<Awaited<ReturnType<typeof getAssessmentCompetencyInsight>>|null>(null),[error,setError]=useState(''),[busy,start]=useTransition(),sequence=useRef(0);
 const load=(generate:boolean)=>{const request=++sequence.current;setResult(null);setError('');start(async()=>{try{const response=await assessmentCompetencyInsightAction(reviewId,generate);if(request!==sequence.current)return;if('error' in response)setError(response.error);else setResult(response);}catch{if(request===sequence.current)setError(t('insight.unavailable'));}});};
 return <details className="rounded-lg border border-border" onToggle={e=>{if(e.currentTarget.open)load(false);else{sequence.current++;setResult(null);setError('');}}}>
  <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">{t('competencyInsight.title')}</summary>
  <div className="space-y-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">{t('competencyInsight.help')}</p>
   {busy&&<p role="status">{t('insight.working')}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {!busy&&result&&!['submitted','reviewed'].includes(result.status)&&<p>{t('competencyInsight.none')}</p>}
   {!busy&&!error&&(!result||result.pending)&&<Button type="button" variant="secondary" onClick={()=>load(true)}>{t('insight.generate')}</Button>}
   {!busy&&result?.data&&<><p className="text-sm font-semibold">{result.data.verdict&&t(`insight.verdict.${result.data.verdict}`)}</p><p className="text-sm">{result.data.verdict_why}</p><p className="text-sm leading-relaxed">{result.data.paragraph}</p>{result.data.discuss.length>0&&<div><h3 className="text-sm font-medium">{t('insight.nextSteps')}</h3><ul className="list-disc space-y-2 pl-5 text-sm">{result.data.discuss.map(s=><li key={s}>{s}</li>)}</ul></div>}</>}
  </div>
 </details>;
}
