'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {bulkJobActive,bulkJobPercent} from '@/lib/bulk-job';
import type {RunGroupView} from '@/core/payroll-run-group-store';

const pollMs=2000;
type Progress=Pick<RunGroupView,'done'|'companies'|'worker'>;

/** The wizard's result screen while its runs process in the background: the run screen's processing panel
 * (app/payroll/[batchId]/processing-progress.tsx), one row per company, and a refresh to the outcomes once every
 * company's run has finished. */
export function RunGroupProgressPanel({groupId,initial}:{groupId:string;initial:Progress}){
 const t=useTranslations('payroll.batch.processingJob');
 const tp=useTranslations('payroll.process');
 const router=useRouter();
 const [progress,setProgress]=useState(initial),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const settled=useRef(initial.done);
 useEffect(()=>{
  if(initial.done)return;
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`/payroll/process/result/status?g=${encodeURIComponent(groupId)}`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload)throw new Error(payload?.error??'');
    if(alive){setProgress(payload);setError('');setCheckedAt(Date.now());again=!payload.done;}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[groupId,initial.done]);
 useEffect(()=>{
  if(settled.current||!progress.done)return;
  settled.current=true;router.refresh();
 },[progress,router]);
 return <Card className="space-y-4 p-5">
  <h3 className="text-sm font-semibold">{t('title')}</h3>
  <ul className="space-y-3">
   {progress.companies.map(company=>{
    const job=company.job;
    // A company refused before its run could start (no access, no cycle, nothing selected) is already failed.
    const stateText=job?t(`state.${job.state}`):company.status==='failed'?tp('companyFailed'):t('othersRun');
    return <li key={company.companyId} className="space-y-1">
     <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-sm">{company.companyName}</span><span role="status" className="text-sm">{stateText}</span></div>
     {job&&bulkJobActive(job.state)&&<><progress aria-label={`${company.companyName}: ${stateText}`} value={bulkJobPercent(job)} max={100} className="h-2 w-full accent-primary"/>
      <p className="text-xs text-muted-foreground">{t('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p></>}
    </li>;
   })}
  </ul>
  <p className="text-xs text-muted-foreground">{progress.companies.some(c=>c.job?.state==='queued')&&progress.worker==='unavailable'?t('workerUnavailable')
   :progress.companies.some(c=>c.job&&bulkJobActive(c.job.state)&&checkedAt-Date.parse(c.job.updatedAt)>90_000)?t('waiting'):t('backgroundHelp')}</p>
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
