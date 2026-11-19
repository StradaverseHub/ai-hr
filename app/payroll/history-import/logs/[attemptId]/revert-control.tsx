'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useCallback,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {previewHistoryRevertAction,revertHistoryUploadAction} from '../../workflow-actions';
import {HistoryJobPanel} from '../../history-job-progress';
import type {BulkJobProgress} from '@/lib/bulk-job';
export function RevertControl({attemptId,count}:{attemptId:string;count:number}){
 const t=useTranslations('payroll.historyRevisions'),router=useRouter();
 const [open,setOpen]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[previewHash,setPreviewHash]=useState<string|null>(null);
 async function review(){setBusy(true);setError(null);setConfirmed(false);setPreviewHash(null);try{const result=await previewHistoryRevertAction(attemptId);if(!result.ok)setError(result.error??t('failed'));else if(result.result.count!==count)setError(t('revertChanged'));else{setPreviewHash(result.result.previewHash);setOpen(true);}}catch{setError(t('failed'));}finally{setBusy(false);}}
 // The revert commits in the background; the panel follows the job, then the log refreshes with its outcome.
 const [jobId,setJobId]=useState<string|null>(null);
 const finished=useCallback((job:BulkJobProgress)=>{setJobId(null);setBusy(false);setOpen(false);setPreviewHash(null);setConfirmed(false);if(job.state!=='completed')setError(job.error??t('failed'));router.refresh();},[router,t]);
 async function revert(){if(!previewHash)return;setBusy(true);setError(null);let following=false;try{const result=await revertHistoryUploadAction(attemptId,previewHash);if(!result.ok){setError(result.error??t('failed'));setOpen(false);setPreviewHash(null);setConfirmed(false);}else{following=true;setJobId(result.jobId);}}catch{setError(t('failed'));setOpen(false);setPreviewHash(null);setConfirmed(false);}finally{if(!following)setBusy(false);}}
 return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">{t('revert')}</h2><p className="text-sm text-muted-foreground">{t('revertHint')}</p>{!open?<ActionButton type="button" className="min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40" disabled={busy} aria-busy={busy} onClick={review}>{busy?t('working'):t('reviewRevert')}</ActionButton>:<div className="space-y-3"><p className="text-sm">{t('revertConfirmation',{count})}</p><label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)} className="mt-1"/><span>{t('revertAcknowledgement')}</span></label><div className="flex gap-3"><ActionButton guardNavigation aria-busy={busy} type="button" disabled={!confirmed||busy||!previewHash} className="min-h-11 rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:opacity-40" onClick={revert}>{busy?t('working'):t('revert')}</ActionButton><ActionButton guardNavigation aria-busy={busy} type="button" disabled={busy} className="min-h-11 rounded-lg border px-4 py-2 text-sm" onClick={()=>{setOpen(false);setConfirmed(false);setPreviewHash(null);}}>{t('cancel')}</ActionButton></div></div>}{jobId&&<HistoryJobPanel jobId={jobId} onFinished={finished}/>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</section>;
}
