'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {employeeImportActive,employeeImportPercent,type EmployeeImportProgress} from '@/lib/employee-import-job';
import type {ImportResult} from '@/lib/import-schema';

const endpoint='/admin/personnel/import/employee/jobs';
const pollMs=2000;

/** Shows a running background employee import and hands the finished outcome to the existing result panel. */
export function EmployeeImportJobPanel({job:initial,onFinished}:{job:EmployeeImportProgress;onFinished:(result:ImportResult)=>void}){
 const j=useTranslations('people.import.employeeJob');
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
    if(alive){setJob(payload.job);setError('');setCheckedAt(Date.now());again=employeeImportActive(payload.job.state);}
   }catch(e){if(alive)setError((e as Error).message||'');}
   finally{if(alive&&again)timer=setTimeout(poll,pollMs);}
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[initial.id]);
 useEffect(()=>{
  if(finished.current||employeeImportActive(job.state))return;
  finished.current=true;
  const r=job.result;
  onFinished(r?{companyId:r.companyId,imported:r.imported,failed:r.failed,skipped:r.skipped,dependentsImported:r.dependentsImported,registersImported:r.registersImported,superiorFailed:r.superiorFailed,fileErrors:r.fileErrors,warnings:r.warnings,runId:r.runId,attemptId:r.attemptId}:
   {companyId:'',imported:job.state==='completed'?job.imported:0,failed:job.errors.map(e=>({rowNum:e.rowNum,email:e.email,message:e.message})),skipped:job.total-job.valid,dependentsImported:0,superiorFailed:[],fileErrors:job.error?[job.error]:[],warnings:[],runId:null,attemptId:job.attemptId});
 },[job,onFinished]);
 const stateText=j(job.state);
 const percent=employeeImportPercent(job);
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-semibold">{job.sourceName}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {employeeImportActive(job.state)&&<><progress aria-label={stateText} value={percent} max={100} className="h-2 w-full accent-primary"/>
   <p className="text-xs text-muted-foreground">{job.phase&&job.state==='importing'?`${j(`phase.${job.phase}`)} · `:''}{j('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>
   <p className="text-xs text-muted-foreground">{checkedAt-Date.parse(job.updatedAt)>90_000?j('waiting'):j('backgroundHelp')}</p></>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
