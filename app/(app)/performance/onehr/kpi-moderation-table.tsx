'use client';
import { RewriteField } from './rewrite-field';
import { rewriteAssessmentFieldAction } from '../assessment-rewrite-actions';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';
import { inputCls } from '@/components/ui';
import { scorecard,scoreKPI,type KPI,type Policy } from '@/packs/performance/onehr/model';
import { sourceFigure,sourceGroupedFigure } from '@/packs/performance/onehr/source-numeric';
import type { PerformanceInsight as Insight } from '@/packs/performance/onehr/performance-insight-model';
import { PerformanceInsight } from './performance-insight';

type Props={reviewId:string;kpis:KPI[];editableIds:string[];draft:{lines:{id:string;actual:number|null;note:string}[]}|null;files:{id:string;fileName:string;kpiId:string}[];bands:Pick<Policy,'aBands'|'bBands'>;companyId:string;remark:string;remarkApplies:boolean;selfRemark:string;selfRemarkAvailable:boolean;aiEnabled?:boolean};
/** The source reviewer table uses the same scoring owner as the employee form. Previews never publish a rating. */
export function KpiModerationTable({reviewId,kpis,editableIds,draft,files,bands,companyId,remark,remarkApplies,selfRemark,selfRemarkAvailable,aiEnabled=false}:Props){
 const t=useTranslations('onehr'),[insight,setInsight]=useState<Insight|null>(null),[ownRemark,setOwnRemark]=useState(remark);
 const [values,setValues]=useState(()=>Object.fromEntries(kpis.map(k=>[k.id,k.locked?k.approvedActual??k.actual:draft?.lines.find(l=>l.id===k.id)?.actual??k.approvedActual??k.actual])));
 const mechanism=kpis[0]?.scoring.mechanism??'A',variant=kpis[0]?.scoring.mechanism==='B'?kpis[0].scoring.variant:'base';
 const scaleCount=mechanism==='A'?5:3,headings=mechanism==='A'?['1','2','3','4','5']:[t('threshold'),t('target'),t(variant==='excellence'?'excellence':'multiple')];
 const mine=kpis.filter(k=>!k.hrOwned),preview=mine.map(k=>({...k,locked:true,approvedActual:values[k.id]??null}));
 const complete=preview.every(k=>k.approvedActual!=null);
 let self:{score:number|null;band:string|null}={score:null,band:null},moderated=self;
 try{self=scorecard(mine,bands,companyId,false);if(complete)moderated=scorecard(preview,bands,companyId,true);}catch{}
 const required=!!(editableIds.length&&remarkApplies&&self.band&&moderated.band&&self.band!==moderated.band),words=ownRemark.trim().split(/\s+/u).filter(Boolean).length;
 const figure=(value:number|null)=>value==null?'—':sourceFigure(value,2)+(mechanism==='B'?'%':'');
 return <div className="space-y-5">
  <PerformanceInsight reviewId={reviewId} onResult={setInsight}/>
  <div role="region" aria-label={t('moderationTable.title')} tabIndex={0} className="max-w-full overflow-x-auto rounded-lg border border-border outline-offset-2">
   <table className="w-full min-w-[54rem] border-collapse text-sm"><caption className="sr-only">{t('moderationTable.title')}</caption>
    <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th rowSpan={2} scope="col" className="w-[28%] px-3 py-3 text-left">{t('kpi')}</th><th rowSpan={2} scope="col" className="whitespace-nowrap px-2 text-right">{t('weight')}</th><th colSpan={scaleCount} scope="colgroup" className="whitespace-nowrap px-2 pt-3">{t('ratingScale')}</th><th rowSpan={2} scope="col" className="px-3 text-left">{t('moderationTable.theirResult')}</th>{mechanism==='B'&&<th rowSpan={2} scope="col" className="px-2">{t('moderationTable.theirRating')}</th>}<th rowSpan={2} scope="col" className="px-2">{t('moderationTable.justified')}</th><th rowSpan={2} scope="col" className="min-w-36 px-3 text-left">{t('moderationTable.moderate')}</th></tr><tr>{headings.map(heading=><th key={heading} scope="col" className="whitespace-nowrap px-2 py-2 font-medium">{heading}</th>)}</tr></thead>
    <tbody>{kpis.map(k=>{
     const editable=editableIds.includes(k.id)&&!k.hrOwned,line=draft?.lines.find(l=>l.id===k.id),value=values[k.id],numbers=k.scoring.mechanism==='A'?k.scoring.rates:[k.scoring.threshold,k.scoring.target,k.scoring.variant==='excellence'?k.scoring.excellence:k.scoring.multiple];
     let theirRating:number|null=null,rating:number|null=null;try{if(k.actual!=null)theirRating=scoreKPI(k.actual,k.scoring);if(value!=null)rating=scoreKPI(value,k.scoring);}catch{}
     const matches=insight?.kpis.filter(row=>row.kpi===k.title)??[],read=matches.length===1?matches[0]:null;
     return <tr id={`kpi-${k.id}`} key={k.id} className="scroll-mt-4 border-t border-border align-top">
      <th scope="row" className="px-3 py-3 text-left font-normal"><div className="font-semibold">{k.title}</div>{k.description&&<p className="mt-1 text-xs leading-snug text-muted-foreground">{k.description}</p>}{k.scoring.method==='less'&&<p className="mt-1 text-xs text-muted-foreground">{t('less')}</p>}{k.hrOwned&&<p className="mt-1 text-xs text-muted-foreground">{t('companyKpiOwned')}</p>}{k.note&&<details className="mt-2 text-xs"><summary className="min-h-8 cursor-pointer text-primary">{t('moderationTable.theirNote')}</summary><p className="whitespace-pre-wrap py-1 text-muted-foreground">{k.note}</p></details>}{files.filter(f=>f.kpiId===k.id).map(file=><a key={file.id} href={`/performance/attachment/${file.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="mt-2 flex items-start gap-1 break-words text-xs text-primary underline"><Paperclip size={13} className="shrink-0" aria-hidden/>{file.fileName}</a>)}</th>
      <td className="px-2 py-3 text-right tabular-nums">{k.weightBp/100}%</td>
      {numbers.map((number,index)=><td key={index} className={`min-w-10 px-2 py-3 text-center tabular-nums ${mechanism==='A'&&rating===index+1?'bg-primary/10 font-semibold text-primary':mechanism==='A'&&theirRating===index+1&&rating!==theirRating?'text-muted-foreground line-through opacity-60':'text-muted-foreground'}`}>{number??'—'}</td>)}
      <td className="px-3 py-3 tabular-nums">{k.actual==null?'—':sourceGroupedFigure(k.actual)}<span className="ml-1 text-xs text-muted-foreground">{k.unit}</span></td>
      {mechanism==='B'&&<td className="px-2 py-3 text-center tabular-nums">{figure(theirRating)}</td>}
      <td className="px-2 py-3 text-center text-xs">{!k.hrOwned&&read?<details><summary className="min-h-8 cursor-pointer">{t(`insight.justified.${read.justified}`)}</summary><p className="max-w-52 py-2 text-left text-muted-foreground">{read.justified_why}</p></details>:'—'}</td>
      <td className="px-3 py-3">{editable?<div className="space-y-2"><input type="hidden" name="kpiId" value={k.id}/><label className="block"><span className="sr-only">{t('moderationTable.moderatedResult',{kpi:k.title})}</span><input required aria-label={t('moderationTable.moderatedResult',{kpi:k.title})} type="number" step="any" name={`${k.id}.actual`} value={value??''} onChange={event=>setValues(previous=>({...previous,[k.id]:event.target.value===''?null:Number(event.target.value)}))} className={`${inputCls} min-h-10 w-24! tabular-nums`}/></label><details><summary className="min-h-8 cursor-pointer text-xs text-primary">{t('reason')}</summary><RewriteField enabled={aiEnabled} target={{kind:'kpi_justification',id:k.id}} rewriteAction={rewriteAssessmentFieldAction.bind(null,reviewId)}><label><span className="sr-only">{t('moderationTable.justificationFor',{kpi:k.title})}</span><textarea aria-label={t('moderationTable.justificationFor',{kpi:k.title})} name={`${k.id}.note`} rows={2} maxLength={4000} defaultValue={line?.note??k.moderationRemark} className={inputCls}/></label></RewriteField></details></div>:<p className="tabular-nums">{value==null?'—':sourceGroupedFigure(value)}{k.locked&&<span className="mt-1 block text-xs text-muted-foreground">{t('confirmed')}</span>}</p>}{mechanism==='B'&&rating!=null&&<p className="mt-1 text-xs text-muted-foreground">{figure(rating)}</p>}</td>
     </tr>;
    })}</tbody>
   </table>
  </div>
  <div className="space-y-1 text-sm"><p>{t('moderationTable.theirOverall')}: <b className="tabular-nums">{figure(self.score)}{self.band?` · ${self.band}`:''}</b>{' · '}{t('moderationTable.moderatedOverall')}: <b aria-live="polite" className="tabular-nums">{figure(moderated.score)}{moderated.band?` · ${moderated.band}`:''}</b></p><p className="text-xs text-muted-foreground">{t('moderationTable.scopeHelp')}</p></div>
  {selfRemarkAvailable&&<section className="space-y-1"><h3 className="text-xs font-medium text-muted-foreground">{t('moderationTable.theirRemark')}</h3><blockquote className="whitespace-pre-wrap text-sm">{selfRemark||'—'}</blockquote></section>}
  <RewriteField enabled={aiEnabled&&editableIds.length>0} target={{kind:'pm_manager_remark'}} rewriteAction={rewriteAssessmentFieldAction.bind(null,reviewId)}><label className="block space-y-2"><span className="block text-sm font-medium">{t('moderationTable.yourRemark')}{required?' *':''}</span><textarea aria-label={t('moderationTable.yourRemark')} aria-describedby={`${reviewId}-reviewer-remark-help`} name="overallRemark" rows={3} value={ownRemark} onChange={event=>setOwnRemark(event.target.value)} required={required} readOnly={!editableIds.length} maxLength={4000} className={inputCls}/><span id={`${reviewId}-reviewer-remark-help`} className="block text-xs text-muted-foreground">{t('moderationTable.remarkWords',{count:words})}</span>{required&&<span className="block text-xs text-muted-foreground">{t('moderationTable.remarkRequired')}</span>}</label></RewriteField>
 </div>;
}
