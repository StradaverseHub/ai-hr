'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {NativeInsightOutline} from './native-insight-outline';
import {assessmentIdpFitAction} from '../onehr-actions';
import {flushAssessmentDrafts} from './draft-form';
import type {getAssessmentIdpFit} from '@/packs/performance/service';
export function IdpFitInsight({reviewId,sessionId,initialOpen=false}:{reviewId:string;sessionId?:string;initialOpen?:boolean}){
 const t=useTranslations('onehr'),[result,setResult]=useState<Awaited<ReturnType<typeof getAssessmentIdpFit>>|null>(null),[error,setError]=useState(''),[busy,start]=useTransition(),sequence=useRef(0);
 const load=(generate:boolean)=>{const request=++sequence.current;setResult(null);setError('');start(async()=>{try{await flushAssessmentDrafts();const response=await assessmentIdpFitAction(reviewId,generate,sessionId);if(request!==sequence.current)return;if('error' in response)setError(response.error);else setResult(response);}catch{if(request===sequence.current)setError(t('insight.unavailable'));}});};
 const details=useRef<HTMLDetailsElement>(null);useEffect(()=>{if(initialOpen&&details.current)details.current.open=true;},[initialOpen]);
 return <details ref={details} className="rounded-lg border border-border" onToggle={e=>{if(e.currentTarget.open)load(false);else{sequence.current++;setResult(null);setError('');}}}>
  <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">{t('idpFit.title')}</summary>
  <div className="space-y-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">{t('idpFit.help')}</p>
   {busy&&<p role="status">{t('insight.working')}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {!busy&&result&&!['shared','closed'].includes(result.status)&&<p>{t('idpFit.none')}</p>}
   {!busy&&!error&&result?.canGenerate&&result.pending&&<Button type="button" variant="secondary" onClick={()=>load(true)}>{t('insight.generate')}</Button>}
   {!busy&&result?.data&&<><p className="text-sm font-semibold">{t(`idpFit.verdict.${result.data.verdict}`)}</p><p className="text-sm">{result.data.verdict_why}</p>{result.data.scores&&<p className="text-xs text-muted-foreground">{result.data.scores}</p>}<p className="text-sm leading-relaxed">{result.data.paragraph}</p>{result.data.discuss.length>0&&<div><h3 className="text-sm font-medium">{t('insight.nextSteps')}</h3><ul className="list-disc space-y-2 pl-5 text-sm">{result.data.discuss.map(s=><li key={s}>{s}</li>)}</ul></div>}<NativeInsightOutline data={result.data} variant="idp"/></>}
  </div>
 </details>;
}
