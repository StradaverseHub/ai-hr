'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {NativeInsightOutline} from './native-insight-outline';
import {assessmentWrittenRemarksAction} from '../onehr-actions';
import type {getAssessmentWrittenRemarks} from '@/packs/performance/service';
import type {WrittenAxis} from '@/packs/performance/onehr/written-remarks-model';
/** Full attributed remarks load with the summary; generating is always an explicit human action. */
export function WrittenRemarks({reviewId,sessionId,axis}:{reviewId:string;sessionId:string;axis:WrittenAxis}){
 const t=useTranslations('onehr'),[result,setResult]=useState<Awaited<ReturnType<typeof getAssessmentWrittenRemarks>>|null>(null),[error,setError]=useState(''),[busy,start]=useTransition(),sequence=useRef(0);
 const load=(generate:boolean)=>{const request=++sequence.current;setError('');start(async()=>{try{const response=await assessmentWrittenRemarksAction(reviewId,sessionId,axis,generate);if(request!==sequence.current)return;if('error' in response)setError(response.error);else setResult(response);}catch{if(request===sequence.current)setError(t('insight.unavailable'));}});};
 useEffect(()=>()=>{sequence.current++;},[]);
 return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(`writtenRemarks.${axis}`)}>
  <h4 className="text-sm font-medium">{t(`writtenRemarks.${axis}`)}</h4><p className="text-xs text-muted-foreground">{t('writtenRemarks.help')}</p>
  {busy&&<p role="status">{t('insight.working')}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!busy&&!result&&<Button type="button" variant="secondary" onClick={()=>load(false)}>{t('writtenRemarks.read')}</Button>}
  {!busy&&result?.pending&&<Button type="button" variant="secondary" onClick={()=>load(true)}>{t('insight.generate')}</Button>}
  {!busy&&result?.data&&<><p className="text-sm leading-relaxed">{result.data.paragraph}</p><NativeInsightOutline data={result.data} paragraphKind="remark"/></>}
  {result&&result.entries.length>0&&<details><summary className="min-h-11 cursor-pointer py-3 text-sm text-primary">{t('writtenRemarks.full')}</summary><ol className="space-y-4">{result.entries.map((e,i)=><li key={i} className="space-y-1 border-l-2 border-border pl-3"><p className="text-sm font-medium">{e.who}{e.on&&` · ${e.on}`}{e.move&&` · ${e.move}`}</p><blockquote className="whitespace-pre-wrap break-words text-sm leading-relaxed">{e.text}</blockquote></li>)}</ol></details>}
 </section>;
}
