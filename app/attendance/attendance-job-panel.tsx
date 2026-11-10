'use client';
/**
 * A running background attendance job (Import Clocking Data, Recompute Attendance preview and apply; draft 9940),
 * shown the way the employee import shows its job (app/admin/personnel/import/employee-import-progress.tsx): the
 * file or scope, the state, a progress bar with the employees done, and what to expect while it runs. It polls the
 * screen's own jobs route and hands the finished job back once, so the screen shows its existing result.
 */
import {useEffect,useRef,useState} from 'react';
import {Card} from '@/components/ui';
import {attendanceJobActive,attendanceJobPercent,type AttendanceJobProgress} from '@/lib/attendance-bulk-job';

const pollMs=2000;
/** `t` reads the screen's `job` messages: the state names, progressCount, backgroundHelp, waiting, workerUnavailable. */
export function AttendanceJobPanel<R>({job:initial,endpoint,title,t,onFinished}:{job:AttendanceJobProgress<R>;endpoint:string;title:string;t:(key:string,values?:Record<string,string|number>)=>string;onFinished:(job:AttendanceJobProgress<R>)=>void}){
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
    if(alive){setJob(payload.job);setError('');setCheckedAt(Date.now());again=attendanceJobActive(payload.job.state);}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[initial.id,endpoint]);
 useEffect(()=>{
  if(finished.current||attendanceJobActive(job.state))return;
  finished.current=true;onFinished(job);
 },[job,onFinished]);
 const stateText=t(job.state);
 const percent=attendanceJobPercent(job);
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-semibold">{title}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {attendanceJobActive(job.state)&&<><progress aria-label={stateText} value={percent} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{t('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&job.worker==='unavailable'?t('workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?t('waiting'):t('backgroundHelp')}</p></>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
