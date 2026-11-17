'use client';
import {useEffect,useState} from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {Button,Card,inputCls,tableWrapCls,theadCls,thCls,tbodyCls} from '@/components/ui';
import type {BulkJobProgress} from '@/lib/bulk-job';
import {bulkJobActive} from '@/lib/bulk-job';
import {historyProgressAction,importHistoryAction,previewHistoryAction,stopHistoryAction} from './actions';

type Preview=Extract<Awaited<ReturnType<typeof previewHistoryAction>>,{ok:true}>['preview'];
export function RewardHistoryUploadEditor({companies,initialProgress}:{companies:{id:string;name:string}[];initialProgress:BulkJobProgress|null}){
 const t=useTranslations('rewardsPersonHistoryUpload'),locale=useLocale(),[companyId,setCompanyId]=useState(companies[0]?.id??''),[source,setSource]=useState<{companyId:string;csv:string;name:string}|null>(null),
  [preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[jobId,setJobId]=useState<string|null>(initialProgress?.id??null),[progress,setProgress]=useState<BulkJobProgress|null>(initialProgress);
 useEffect(()=>{
  if(!jobId||(progress&&!bulkJobActive(progress.state)))return;let active=true;
  const poll=async()=>{try{const result=await historyProgressAction(jobId);if(!active)return;if(result.ok)setProgress(result.progress);else setError(result.error);}catch{if(active)setError(t('error'));}};
  void poll();const timer=setInterval(()=>{void poll();},4000);return()=>{active=false;clearInterval(timer);};
 },[jobId,progress?.state,t]);
 const running=!!jobId&&(!progress||bulkJobActive(progress.state));
 const reset=()=>{setPreview(null);setSource(null);setError('');};
 return <div className="space-y-5">
  <Card className="space-y-4 p-5">
   <p className="max-w-3xl text-sm text-muted-foreground">{t('help')}</p>
   <div className="grid gap-4 sm:grid-cols-2">
    <label className="space-y-1 text-sm font-medium">{t('company')}<select className={inputCls} value={companyId} disabled={busy||running} onChange={e=>{setCompanyId(e.target.value);reset();}}>{companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
    <label className="space-y-1 text-sm font-medium">{t('file')}<input key={companyId} className="block w-full rounded-md border border-input p-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" type="file" accept=".csv,.xlsx" disabled={busy||running} onChange={async e=>{
     const file=e.target.files?.[0];reset();if(!file)return;setBusy(true);
     try{
      if(file.size>5_000_000||!(/\.(csv|xlsx)$/i.test(file.name)))throw Error(t('fileError'));
      const csv=/\.xlsx$/i.test(file.name)?(await(await import('@/lib/spreadsheet')).workbookToCsvTexts(await file.arrayBuffer(),[],false,[],false,false,{maxRows:10001,maxCells:90009,literalCells:true})).first:await file.text();
      const input={companyId,csv,name:file.name},result=await previewHistoryAction(input);
      if(result.ok){setSource(input);setPreview(result.preview);}else setError(result.error);
     }catch(cause){setError(cause instanceof Error&&cause.message==='NON_LITERAL_CELL'?t('literalCells'):t('fileError'));}finally{setBusy(false);}
    }}/></label>
   </div>
   <a className="inline-flex text-sm font-medium text-primary underline underline-offset-4" href="/rewards/history-upload/template">{t('template')}</a>
   {busy&&<p role="status" className="text-sm">{t('working')}</p>}
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </Card>
  {preview&&<section className="space-y-3" aria-labelledby="history-preview-title">
   <h2 id="history-preview-title" className="text-base font-semibold">{t('previewTitle')}</h2>
   <p role="status" className="text-sm">{t('summary',{accepted:preview.rows.length,problems:preview.problems.length})}</p>
   {preview.firstReviewYear!==null&&<p className="text-sm text-muted-foreground">{t('cutoff',{year:preview.firstReviewYear})}</p>}
   {preview.problems.length>0&&<ul className="max-h-60 overflow-auto rounded-md border border-destructive/30 p-3 text-sm text-destructive">{preview.problems.map((problem,i)=><li key={`${problem.line}-${i}`}>{t('problem',{line:problem.line,reason:t(`problems.${problem.code}`)})}</li>)}</ul>}
   {preview.rows.length>0&&<div className={`${tableWrapCls} max-h-96 overflow-auto`}><table className="w-full text-[13px]"><thead className={`${theadCls} sticky top-0`}><tr>{(['employee','year','talent','performance','incrementPercent','incrementMoney','bonusMoney','bonusMonths','type'] as const).map(key=><th key={key} className={thCls} scope="col">{t(key)}</th>)}</tr></thead>
    <tbody className={tbodyCls}>{preview.rows.map(({line,value})=><tr key={line}><td className="px-3 py-2">{value.employeeCode}</td><td className="px-3 py-2 tabular-nums">{value.year}</td><td className="px-3 py-2">{value.talent??'—'}</td><td className="px-3 py-2">{value.performance??'—'}</td>{[value.incrementBp/100,value.incrementCents/100,value.bonusCents/100,value.bonusMonthsBp/10000].map((amount,i)=><td key={i} className="px-3 py-2 text-right tabular-nums">{amount.toLocaleString(locale,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>)}<td className="px-3 py-2">{t(value.kind)}</td></tr>)}</tbody></table></div>}
   <p className="text-sm text-muted-foreground">{t('replaceHelp')}</p>
   <Button disabled={busy||running||preview.problems.length>0||!preview.rows.length||!source} onClick={async()=>{
    if(!source)return;setBusy(true);setError('');try{const result=await importHistoryAction(source,preview.token);if(result.ok){setJobId(result.jobId);setProgress(null);setPreview(null);}else setError(result.error);}catch{setError(t('error'));}finally{setBusy(false);}
   }}>{t('confirm')}</Button>
  </section>}
  {jobId&&<Card className="space-y-3 p-5" aria-live="polite"><h2 className="text-base font-semibold">{t('progressTitle')}</h2>
   <p className="text-sm">{progress?t(`states.${progress.state}`):t('working')}</p>
   {progress&&<><p className="text-sm tabular-nums">{t('progress',{done:progress.stepsDone,total:progress.stepsTotal})}</p>{progress.error&&<p role="alert" className="text-sm text-destructive">{progress.error}</p>}{progress.errors.length>0&&<ul className="max-h-48 overflow-auto text-sm">{progress.errors.map((issue,i)=><li key={i}>{t('problem',{line:issue.rowNum,reason:issue.message})}</li>)}</ul>}</>}
   {running&&<Button variant="outline" disabled={busy||progress?.cancelRequested} onClick={async()=>{setBusy(true);try{const result=await stopHistoryAction(jobId);if(result.ok){const fresh=await historyProgressAction(jobId);if(fresh.ok)setProgress(fresh.progress);}else setError(result.error);}catch{setError(t('error'));}finally{setBusy(false);}}>{t(progress?.cancelRequested?'stopping':'stop')}</Button>}
   <p className="text-sm text-muted-foreground">{t('checkpointHelp')}</p>
  </Card>}
 </div>;
}
