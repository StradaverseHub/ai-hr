'use client';
import { RewriteField } from './rewrite-field';
import { rewriteAssessmentFieldAction } from '../assessment-rewrite-actions';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';
import { Button,inputCls } from '@/components/ui';
import { scorecard,scoreKPI,type KPI,type Policy } from '@/packs/performance/onehr/model';
import { sourceFigure } from '@/packs/performance/onehr/source-numeric';
import { evidenceFileExtensions } from '@/packs/performance/onehr/evidence-file-model';

type File={id:string;fileName:string;kpiId:string};
/** One source-style scorecard table. File controls belong to separate upload forms, never the draft payload. */
export function KpiResultsTable({kpis,draft,files,bands,companyId,evidence,reviewId,aiEnabled=false}:{reviewId?:string;aiEnabled?:boolean;kpis:KPI[];draft:{lines:{id:string;actual:number|null;note:string}[]}|null;files:File[];bands:Pick<Policy,'aBands'|'bBands'>;companyId:string;evidence:boolean}){
 const t=useTranslations('onehr'),[actuals,setActuals]=useState(()=>Object.fromEntries(kpis.map(k=>[k.id,draft?.lines.find(line=>line.id===k.id)?.actual??k.actual])));
 const mechanism=kpis[0]?.scoring.mechanism??'A',variant=kpis[0]?.scoring.mechanism==='B'?kpis[0].scoring.variant:'base';
 const columns=mechanism==='A'?5:3,scoring=kpis.map(k=>({...k,actual:actuals[k.id]??null}));
 let total:{score:number|null;band:string|null}={score:null,band:null};try{total=scorecard(scoring,bands,companyId,false);}catch{}
 const headings=mechanism==='A'?['1','2','3','4','5']:[t('threshold'),t('target'),t(variant==='excellence'?'excellence':'multiple')];
 return <div role="region" aria-label={t('scorecard')} tabIndex={0} className="max-w-full overflow-x-auto rounded-lg border border-border outline-offset-2">
  <table className="w-full min-w-[44rem] border-collapse text-sm"><caption className="sr-only">{t('scorecard')}</caption>
   <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th rowSpan={2} scope="col" className="w-[34%] px-3 py-3 text-left">{t('kpi')}</th><th rowSpan={2} scope="col" className="whitespace-nowrap px-2 text-right">{t('weight')}</th><th colSpan={columns} scope="colgroup" className="whitespace-nowrap px-2 pt-3">{t('ratingScale')}</th><th rowSpan={2} scope="col" className="min-w-36 px-3 text-left">{t('actual')}</th>{evidence&&<th rowSpan={2} scope="col" className="px-3">{t('kpiFiles')}</th>}</tr><tr>{headings.map(heading=><th key={heading} scope="col" className="whitespace-nowrap px-2 py-2 font-medium">{heading}</th>)}</tr></thead>
   <tbody>{kpis.map(k=>{
    const line=draft?.lines.find(line=>line.id===k.id),value=actuals[k.id],attachments=files.filter(file=>file.kpiId===k.id),numbers=k.scoring.mechanism==='A'?k.scoring.rates:[k.scoring.threshold,k.scoring.target,k.scoring.variant==='excellence'?k.scoring.excellence:k.scoring.multiple??0];
    let rating:number|null=null;try{if(value!=null)rating=scoreKPI(value,k.scoring);}catch{}
    return <tr id={`kpi-${k.id}`} key={k.id} className="scroll-mt-4 border-t border-border align-top">
     <th scope="row" aria-label={k.title} className="px-3 py-2.5 text-left font-normal">{k.hrOwned?<div className="font-semibold">{k.title}</div>:<><input type="hidden" name="kpiId" value={k.id}/><details><summary aria-label={`${k.title}: ${t('evidenceNote')}`} className="cursor-pointer font-semibold">{k.title}</summary><RewriteField enabled={!!reviewId&&aiEnabled} target={{kind:'kpi_note',id:k.id}} rewriteAction={rewriteAssessmentFieldAction.bind(null,reviewId??'')}><label className="mt-2 block"><span className="sr-only">{t('evidenceNote')}</span><textarea name={`${k.id}.note`} rows={2} maxLength={4000} defaultValue={line?.note??k.note} className={inputCls}/></label></RewriteField></details></>}{k.description&&<p className="mt-1 text-xs leading-snug text-muted-foreground">{k.description}</p>}{k.scoring.method==='less'&&<p className="mt-1 text-xs text-muted-foreground">{t('less')}</p>}{k.hrOwned&&<p className="mt-1 text-xs text-muted-foreground">{t('companyKpiOwned')}</p>}</th>
     <td className="px-2 py-4 text-right tabular-nums">{k.weightBp/100}%</td>
     {numbers.map((number,index)=><td key={index} className={`min-w-10 px-2 py-4 text-center tabular-nums ${mechanism==='A'&&rating===index+1?'bg-primary/10 font-semibold text-primary':'text-muted-foreground'}`}>{number??'—'}</td>)}
     <td className="px-3 py-3"><div className="flex items-center gap-2">{k.hrOwned?<span className="tabular-nums">{value??'—'}</span>:<label className="min-w-0"><span className="sr-only">{t('actual')}</span><input required type="number" step="any" name={`${k.id}.actual`} value={value??''} onChange={event=>setActuals(previous=>({...previous,[k.id]:event.target.value===''?null:Number(event.target.value)}))} className={`${inputCls} min-h-10 w-24! tabular-nums`}/></label>}<span className="text-xs text-muted-foreground">{k.unit}</span></div></td>
     {evidence&&<td className="px-2 py-3"><details className="min-w-10"><summary aria-label={`${k.title}: ${t('attachments')} (${attachments.length})`} className="flex min-h-10 cursor-pointer list-none items-center justify-center gap-1 text-muted-foreground"><Paperclip size={16} aria-hidden/>{attachments.length>0&&<span className="text-xs tabular-nums">{attachments.length}</span>}</summary><div className="min-w-48 space-y-2 py-2">{attachments.map(file=><a key={file.id} href={`/performance/attachment/${file.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="block break-words text-xs text-primary underline">{file.fileName}</a>)}{!k.hrOwned&&<><label className="block"><span className="sr-only">{t('evidenceFile')}</span><input form={`kpi-file-${k.id}`} type="file" name="file" required accept={evidenceFileExtensions.map(ext=>`.${ext}`).join(',')} className={`${inputCls} max-w-52 text-xs`}/></label><Button form={`kpi-file-${k.id}`} type="submit" variant="secondary">{t('uploadAttachment')}</Button></>}<p className="max-w-52 text-xs text-muted-foreground">{t('evidenceFiles.limits')}</p></div></details></td>}
    </tr>;
   })}</tbody>
   <tfoot><tr className="border-t border-border bg-muted/30"><th colSpan={columns+2} className="px-3 py-3 text-left font-semibold">{t('totalKpiScore')}</th><td colSpan={evidence?2:1} aria-live="polite" className="px-3 py-3 text-right font-semibold tabular-nums">{total.score==null?'—':`${sourceFigure(total.score,2)}${mechanism==='B'?'%':''}${total.band?` · ${total.band}`:''}`}</td></tr></tfoot>
  </table>
 </div>;
}
