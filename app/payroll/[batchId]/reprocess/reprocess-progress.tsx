'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';

const pollMs=2000;
type Job={status:string;employmentIds:string[];result:{outcomes?:unknown[]}|null};

/** A selective reprocess running in the background (core/payroll-reprocess-job.ts), the run screen's processing
 * panel pattern: how many of the selected employees are done, and a refresh to the results once the job ends. */
export function ReprocessJobPanel({jobId,initial}:{jobId:string;initial:Job}){
 const t=useTranslations('payroll.batch');
 const router=useRouter();
 const [job,setJob]=useState(initial),[error,setError]=useState('');
 const settled=useRef(false);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`/api/payroll/reprocess-job/${encodeURIComponent(jobId)}`,{cache:'no-store'});
    if(!response.ok)throw new Error(await response.text().catch(()=>''));
    const payload=await response.json() as Job;
    if(alive){setJob(payload);setError('');again=payload.status==='queued'||payload.status==='running';}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[jobId]);
 useEffect(()=>{
  if(settled.current||job.status==='queued'||job.status==='running')return;
  settled.current=true;router.refresh();
 },[job,router]);
 const total=job.employmentIds.length,done=Math.min(total,job.result?.outcomes?.length??0);
 const state=job.status==='queued'?t('reprocessJob.queued'):t('reprocessJob.running');
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{t('reprocessJob.title')}</h3><span role="status" className="text-sm">{state}</span></div>
  <progress aria-label={state} value={total?Math.round(done*100/total):0} max={100} className="h-2 w-full accent-primary"/>
  <p className="text-xs text-muted-foreground">{t('reprocessJob.progress',{done,total})}</p>
  <p className="text-xs text-muted-foreground">{t('reprocessJob.help')}</p>
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
