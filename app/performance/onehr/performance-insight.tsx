'use client';
import { useEffect,useRef,useState,useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { assessmentInsightAction } from '../onehr-actions';
import type { PerformanceInsight as Insight } from '@/packs/performance/onehr/performance-insight-model';
type State={pending:boolean;source:'plain'|'ai'|null;data:Insight|null;status:string};
/** Opening reads an existing insight only. The explicit generation button is the provider/file-reading action. */
export function PerformanceInsight({reviewId,contextId=reviewId,onResult,initialOpen=false}:{reviewId:string;contextId?:string;onResult?:(data:Insight|null)=>void;initialOpen?:boolean}){
 return <InsightContent key={`${reviewId}.${contextId}`} reviewId={reviewId} contextId={contextId} onResult={onResult} initialOpen={initialOpen}/>;
}
function InsightContent({reviewId,contextId,onResult,initialOpen}:{reviewId:string;contextId:string;onResult?:(data:Insight|null)=>void;initialOpen:boolean}){
 const t=useTranslations('onehr.insight'),[result,setResult]=useState<State|null>(null),[error,setError]=useState(''),[busy,start]=useTransition(),sequence=useRef(0);
 const load=(generate:boolean)=>{const request=++sequence.current;setError('');setResult(null);onResult?.(null);start(async()=>{try{const r=await assessmentInsightAction(reviewId,contextId,generate);if(request!==sequence.current)return;if('error' in r)setError(r.error);else {setResult(r);onResult?.(r.data);}}catch{if(request===sequence.current)setError(t('unavailable'));}});};
 const details=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{if(initialOpen&&details.current)details.current.open=true;},[initialOpen]);
 return <details ref={details} className="rounded-lg border border-border" onToggle={event=>{if(event.currentTarget.open)load(false);else{sequence.current++;setResult(null);setError('');}}}>
  <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium"><Sparkles size={16} aria-hidden/>{t('title')}</summary>
  <div className="space-y-4 border-t border-border p-4">
   <p className="text-xs text-muted-foreground">{t('help')}</p>
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {busy&&<p role="status" className="text-sm text-muted-foreground">{t('working')}</p>}
   {!busy&&result?.status==='none'&&<p className="text-sm text-muted-foreground">{t('none')}</p>}
   {!busy&&(!result||result.pending)&&!error&&<Button type="button" variant="secondary" onClick={()=>load(true)}>{t('generate')}</Button>}
   {!busy&&result?.data&&<>
    {result.data.verdict&&<p className="text-sm font-semibold">{t(`verdict.${result.data.verdict}`)}</p>}
    <p className="text-sm leading-relaxed">{result.data.paragraph}</p>
    <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm"><caption className="sr-only">{t('kpiReview')}</caption><thead className="text-xs text-muted-foreground"><tr><th scope="col" className="px-2 py-2">{t('kpi')}</th><th scope="col" className="px-2 py-2">{t('result')}</th><th scope="col" className="px-2 py-2">{t('backing')}</th><th scope="col" className="px-2 py-2">{t('files')}</th></tr></thead><tbody>{result.data.kpis.map((k,index)=><tr key={`${k.kpi}.${index}`} className="border-t border-border align-top"><th scope="row" className="max-w-56 px-2 py-3 font-medium">{k.kpi}</th><td className="px-2 py-3 tabular-nums">{k.mod_result??k.result}<p className="mt-1 text-xs text-muted-foreground">{k.mod_band_now??k.band??'—'}</p></td><td className="max-w-80 space-y-1 px-2 py-3"><p>{t(`justified.${k.justified}`)}</p><p className="text-xs text-muted-foreground">{k.justified_why}</p>{k.evidence_note&&<p className="text-xs text-muted-foreground">{k.evidence_note}</p>}</td><td className="max-w-56 space-y-1 px-2 py-3">{k.files.map(file=><a key={file.id} href={`/performance/attachment/${file.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="block break-words text-xs text-primary underline">{file.name}</a>)}</td></tr>)}</tbody></table></div>
    {result.data.discuss.length>0&&<div><h3 className="text-sm font-medium">{t('nextSteps')}</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-sm">{result.data.discuss.map(step=><li key={step}>{step}</li>)}</ul></div>}
   </>}
  </div>
 </details>;
}
