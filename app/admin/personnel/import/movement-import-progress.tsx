'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {movementCheckJobActive,movementImportJobActive,movementImportJobPercent,type MovementCheckJobState,type MovementImportJobState} from '@/lib/movement-import-job';

const endpoints={import:'/admin/personnel/import/movement/jobs',check:'/admin/personnel/import/movement/checks'} as const;
const pollMs=2000;
type PanelJob={id:string;sourceName:string;stepsTotal:number;stepsDone:number;updatedAt:string;worker?:'running'|'unavailable'};
type KindJob={import:PanelJob&{state:MovementImportJobState};check:PanelJob&{state:MovementCheckJobState}};
const isActive=(kind:'import'|'check',state:string)=>kind==='check'?movementCheckJobActive(state as MovementCheckJobState):movementImportJobActive(state as MovementImportJobState);

/** Shows a running background movement import or check (the employee import panel's pattern) and hands the finished
 * job to the screen, which shows its result, its preview or its refusal exactly as the synchronous request did. */
export function MovementImportJobPanel<K extends 'import'|'check',J extends KindJob[K]>({job:initial,onFinished,kind}:{job:J;onFinished:(job:J)=>void;kind?:K}){
 const which:'import'|'check'=kind??'import';
 const j=useTranslations(which==='check'?'people.import.movementCheckJob':'people.import.movementJob');
 const [job,setJob]=useState(initial),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const finished=useRef(false);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   let again=true;
   try{
    const response=await fetch(`${endpoints[which]}/${initial.id}`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload)throw new Error(payload?.error??'');
    if(alive){setJob(payload.job);setError('');setCheckedAt(Date.now());again=isActive(which,payload.job.state);}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[initial.id,which]);
 useEffect(()=>{
  if(finished.current||isActive(which,job.state))return;
  finished.current=true;onFinished(job);
 },[job,onFinished,which]);
 const stateText=j(job.state);
 const percent=movementImportJobPercent(job as never);
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-semibold">{job.sourceName}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {isActive(which,job.state)&&<><progress aria-label={stateText} value={percent} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{j('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&job.worker==='unavailable'?j('workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?j('waiting'):j('backgroundHelp')}</p></>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
