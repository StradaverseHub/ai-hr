'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {systemLabelImportActive,systemLabelImportPercent,type SystemLabelImportProgress} from '@/lib/system-label-import-job';

const endpoint='/admin/settings/system-labels/import/jobs';
const pollMs=2000;

/** Follows a background System Labels import (same pattern as the employee import's progress panel) and hands the
 * finished job to the wizard once, which shows the existing summary or the reason nothing was imported. */
export function SystemLabelImportJobPanel({job:initial,onFinished}:{job:SystemLabelImportProgress;onFinished:(job:SystemLabelImportProgress)=>void}){
 const j=useTranslations('labelsImportWizard.job');
 const [job,setJob]=useState(initial),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const finished=useRef(false);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`${endpoint}/${initial.id}`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload?.job)throw new Error(j('unavailable'));
    if(alive){setJob(payload.job);setError('');setCheckedAt(Date.now());again=systemLabelImportActive(payload.job.state);}
   }catch(e){if(alive)setError((e as Error).message||j('unavailable'));}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[initial.id,j]);
 useEffect(()=>{
  if(finished.current||systemLabelImportActive(job.state))return;
  finished.current=true;onFinished(job);
 },[job,onFinished]);
 const stateText=j(`state.${job.state}`);
 return <div className="space-y-3 rounded-lg border border-border p-4" data-label-import-job={job.state}>
  <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="break-all text-sm font-semibold">{job.sourceName}</p><span role="status" className="text-sm">{stateText}</span></div>
  {systemLabelImportActive(job.state)&&<><progress aria-label={stateText} value={systemLabelImportPercent(job)} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{j('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&job.worker==='unavailable'?j('workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?j('waiting'):j('backgroundHelp')}</p></>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </div>;
}
