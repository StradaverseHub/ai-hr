'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useCallback,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {previewHistoryRevertAction,revertHistoryUploadAction} from '../../workflow-actions';
import {HistoryJobPanel} from '../../history-job-progress';
import {HistoryMaintenanceImpacts} from '../../maintenance-impact';
import {RevisionPreview} from '../../revision-preview';
import type {HistoryRevisionPlan} from '@/lib/payroll-history-revisions';
import type {PayrollHistoryMaintenanceImpact} from '@/lib/payroll-history-maintenance';
import type {BulkJobProgress} from '@/lib/bulk-job';
export function RevertControl({attemptId,count}:{attemptId:string;count:number}){
 const m=useTranslations('payrollHistoryMaintenance'),t=useTranslations('payroll.historyRevisions'),router=useRouter();
 const [reviewedCount,setReviewedCount]=useState(count),[plan,setPlan]=useState<HistoryRevisionPlan|null>(null),[impact,setImpact]=useState<PayrollHistoryMaintenanceImpact[]>([]);
 const [open,setOpen]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[previewHash,setPreviewHash]=useState<string|null>(null);
 async function review(){setBusy(true);setError(null);setConfirmed(false);setPreviewHash(null);try{const result=await previewHistoryRevertAction(attemptId);if(!result.ok)setError(result.error??t('failed'));else{setReviewedCount(result.result.count);setPlan(result.result.plan??null);setImpact(result.result.impact??[]);setPreviewHash(result.result.previewHash);setOpen(true);}}catch{setError(t('failed'));}finally{setBusy(false);}}
 // The revert commits in the background; the panel follows the job, then the log refreshes with its outcome.
 const [jobId,setJobId]=useState<string|null>(null);
 const finished=useCallback((job:BulkJobProgress)=>{setJobId(null);setBusy(false);setOpen(false);setPreviewHash(null);setConfirmed(false);if(job.state!=='completed')setError(job.error??t('failed'));router.refresh();},[router,t]);
 async function revert(){if(!previewHash)return;setBusy(true);setError(null);let following=false;try{const result=await revertHistoryUploadAction(attemptId,previewHash);if(!result.ok){setError(result.error??t('failed'));setOpen(false);setPreviewHash(null);setConfirmed(false);}else{following=true;setJobId(result.jobId);}}catch{setError(t('failed'));setOpen(false);setPreviewHash(null);setConfirmed(false);}finally{if(!following)setBusy(false);}}
 return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">{t('revert')}</h2><p className="text-sm text-muted-foreground">{m('batchHelp')}</p>{!open?<ActionButton type="button" className="min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40" disabled={busy} aria-busy={busy} onClick={review}>{busy?t('working'):t('reviewRevert')}</ActionButton>:<div className="space-y-3"><p className="text-sm">{m('revertReview',{count:reviewedCount})}</p>{plan&&<RevisionPreview plan={plan}/>}<div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm"><h3 className="font-medium">{m('impact')}</h3><p>{m('impactHelp')}</p><HistoryMaintenanceImpacts items={impact}/></div>{reviewedCount===0&&<p role="status" className="text-sm">{m('noChange')}</p>}<label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)} className="mt-1"/><span>{t('revertAcknowledgement')}</span></label><div className="flex flex-wrap gap-3"><ActionButton guardNavigation aria-busy={busy} type="button" disabled={!confirmed||busy||!previewHash||reviewedCount===0} className="min-h-11 rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:opacity-40" onClick={revert}>{busy?t('working'):t('revert')}</ActionButton><ActionButton guardNavigation aria-busy={busy} type="button" disabled={busy} className="min-h-11 rounded-lg border px-4 py-2 text-sm" onClick={()=>{setOpen(false);setConfirmed(false);setPreviewHash(null);}}>{t('cancel')}</ActionButton></div></div>}{jobId&&<HistoryJobPanel jobId={jobId} onFinished={finished}/>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</section>;
}
