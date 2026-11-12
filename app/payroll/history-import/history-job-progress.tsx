'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {bulkJobActive,bulkJobPercent,type BulkJobProgress} from '@/lib/bulk-job';
import type {PayrollHistoryJobStatus} from '@/lib/payroll-history-job';

const pollMs=2000;

/** A payroll history confirm or revert committing in the background (the employee import and payroll processing
 * panels' pattern): the job's state and progress, and the finished job handed back once to the screen. */
export function HistoryJobPanel({jobId,onFinished}:{jobId:string;onFinished:(job:BulkJobProgress)=>void}){
 const t=useTranslations('payroll.historyRevisions');
 const [status,setStatus]=useState<PayrollHistoryJobStatus|null>(null),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const finished=useRef(false);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`/payroll/history-import/job?id=${encodeURIComponent(jobId)}`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null) as PayrollHistoryJobStatus|{error?:string}|null;
    if(!response.ok||!payload||!('job' in payload))throw new Error((payload as {error?:string}|null)?.error??'');
    if(alive){setStatus(payload);setError('');setCheckedAt(Date.now());again=bulkJobActive(payload.job.state);}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[jobId]);
 useEffect(()=>{
  if(finished.current||!status||bulkJobActive(status.job.state))return;
  finished.current=true;onFinished(status.job);
 },[status,onFinished]);
 const job=status?.job;
 const stateText=job?t(`job.state.${job.state}`):t('job.state.queued');
 return <div className="space-y-3 rounded-lg border p-4" aria-live="polite">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{t('job.title')}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {job&&bulkJobActive(job.state)&&<><progress aria-label={stateText} value={bulkJobPercent(job)} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{t('job.progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&status?.worker==='unavailable'?t('job.workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?t('job.waiting'):t('job.backgroundHelp')}</p></>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </div>;
}
