'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {movementImportJobActive,movementImportJobPercent,type MovementImportJobProgress} from '@/lib/movement-import-job';

const endpoint='/admin/personnel/import/movement/jobs';
const pollMs=2000;

/** Shows a running background movement import (the employee import panel's pattern) and hands the finished job to the
 * screen, which shows its result or its refusal exactly as the synchronous confirmation did. */
export function MovementImportJobPanel({job:initial,onFinished}:{job:MovementImportJobProgress;onFinished:(job:MovementImportJobProgress)=>void}){
 const j=useTranslations('people.import.movementJob');
 const [job,setJob]=useState(initial),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const finished=useRef(false);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`${endpoint}/${initial.id}`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload)throw new Error(payload?.error??'');
    if(alive){setJob(payload.job);setError('');setCheckedAt(Date.now());again=movementImportJobActive(payload.job.state);}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[initial.id]);
 useEffect(()=>{
  if(finished.current||movementImportJobActive(job.state))return;
  finished.current=true;onFinished(job);
 },[job,onFinished]);
 const stateText=j(job.state);
 const percent=movementImportJobPercent(job);
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-semibold">{job.sourceName}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {movementImportJobActive(job.state)&&<><progress aria-label={stateText} value={percent} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{j('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&job.worker==='unavailable'?j('workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?j('waiting'):j('backgroundHelp')}</p></>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
