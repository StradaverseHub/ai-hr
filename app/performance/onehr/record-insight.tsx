'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {NativeInsightOutline} from './native-insight-outline';
import {assessmentRecordInsightAction} from '../onehr-actions';
import type {getAssessmentRecordInsight} from '@/packs/performance/service';
import type {RecordInsightKind} from '@/packs/performance/onehr/record-insight-model';
export function RecordInsight({reviewId,kind}:{reviewId:string;kind:RecordInsightKind}){
 const t=useTranslations('onehr'),[result,setResult]=useState<Awaited<ReturnType<typeof getAssessmentRecordInsight>>|null>(null),[error,setError]=useState(''),[busy,start]=useTransition(),sequence=useRef(0);
 const load=(generate:boolean)=>{const request=++sequence.current;setError('');start(async()=>{try{const response=await assessmentRecordInsightAction(reviewId,kind,generate);if(request!==sequence.current)return;if('error' in response){setResult(null);setError(response.error);}else setResult(response);}catch{if(request===sequence.current){setResult(null);setError(t('insight.unavailable'));}}});};
 useEffect(()=>{load(false);return()=>{sequence.current++;};},[reviewId,kind]); // Reads only the cache on opening; generation remains explicit.
 return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(`recordInsight.${kind}`)}><h3 className="text-sm font-medium">{t(`recordInsight.${kind}`)}</h3>
  {busy&&<p role="status">{t('insight.working')}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!busy&&(!result||result.pending)&&<Button type="button" variant="secondary" onClick={()=>load(true)}>{t('insight.generate')}</Button>}
  {!busy&&result?.data&&<><p className="text-sm leading-relaxed">{result.data.paragraph}</p><NativeInsightOutline data={result.data} paragraphKind={kind==='present'?'current':'history'}/></>}
 </section>;
}
