'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {bulkJobActive,bulkJobPercent} from '@/lib/bulk-job';
import type {PayrollProcessingStatus} from '@/lib/payroll-processing-job';

const pollMs=2000;

/** Background payroll processing on the run screen (the employee import panel's pattern): the job's state and
 * progress while the run is 'processing', its stop reason after a failure, and a refresh when the run settles. */
export function PayrollProcessingPanel({batchId,initial}:{batchId:string;initial:PayrollProcessingStatus}){
 const t=useTranslations('payroll.batch.processingJob');
 const router=useRouter();
 const [status,setStatus]=useState(initial),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const settled=useRef(initial.status!=='processing');
 useEffect(()=>{
  if(initial.status!=='processing')return;
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`/payroll/${batchId}/processing`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload)throw new Error(payload?.error??'');
    if(alive){setStatus(payload);setError('');setCheckedAt(Date.now());again=payload.status==='processing';}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[batchId,initial.status]);
 useEffect(()=>{
  if(settled.current||status.status==='processing')return;
  settled.current=true;router.refresh();
 },[status,router]);
 const job=status.job;
 const processing=status.status==='processing';
 // Another payroll operator's run: the status is theirs to see, the job's detail is its creator's.
 const stateText=job?t(`state.${job.state}`):t('othersRun');
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{t('title')}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {processing&&job&&bulkJobActive(job.state)&&<><progress aria-label={stateText} value={bulkJobPercent(job)} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{t('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&status.worker==='unavailable'?t('workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?t('waiting'):t('backgroundHelp')}</p></>}
  {!processing&&job?.error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{job.error}</p>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
