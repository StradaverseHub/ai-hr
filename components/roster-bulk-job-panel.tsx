'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {rosterBulkActive,rosterBulkPercent,type RosterBulkJobView} from '@/lib/roster-bulk-job';
import {pollRosterBulkJob} from '@/lib/roster-bulk-job-poll';

/**
 * The progress panel for a queued or running background roster job (the employee-import panel's pattern). When the
 * job ends it opens the outcome the synchronous action used to redirect to (`href`), or hands the job to `onFinished`
 * for a screen that renders the outcome in place.
 */
export function RosterBulkJobPanel({endpoint,job:initial,title,waitingLabel,onFinished}:{endpoint:string;job:RosterBulkJobView;title:string;
 /** Shown while the job waits behind another job of its kind (it starts by itself when that one ends). */
 waitingLabel:string;onFinished?:(job:RosterBulkJobView)=>void}){
 const t=useTranslations('bulkJobs.panel');
 const router=useRouter();
 const [job,setJob]=useState(initial),[error,setError]=useState(''),[checkedAt,setCheckedAt]=useState(0);
 const finished=useRef(false);
 useEffect(()=>pollRosterBulkJob(endpoint,initial.id,next=>{setJob(next);setError('');setCheckedAt(Date.now());},setError),[endpoint,initial.id]);
 useEffect(()=>{
  if(finished.current||rosterBulkActive(job.state))return;
  finished.current=true;
  if(onFinished)onFinished(job);
  else if(job.href)router.replace(job.href);
  else router.refresh();
 },[job,onFinished,router]);
 const stateText=t(job.state);
 const active=rosterBulkActive(job.state);
 return <Card className="space-y-3 p-5">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-semibold">{title}</h3><span role="status" className="text-sm">{stateText}</span></div>
  {active&&<><progress aria-label={stateText} value={rosterBulkPercent(job)} max={100} className="h-2 w-full accent-primary"/>
   {job.stepsTotal>0&&<p className="text-xs text-muted-foreground">{t('progressCount',{done:job.stepsDone,total:job.stepsTotal})}</p>}
   <p className="text-xs text-muted-foreground">{job.state==='queued'&&job.waiting?waitingLabel:job.state==='queued'&&job.worker==='unavailable'?t('workerUnavailable'):checkedAt-Date.parse(job.updatedAt)>90_000?t('waiting'):t('backgroundHelp')}</p></>}
  {!active&&!job.href&&!onFinished&&job.error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{job.error}</p>}
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </Card>;
}
