'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {revertHistoryUploadAction} from '../../workflow-actions';
export function RevertControl({attemptId,count}:{attemptId:string;count:number}){
 const t=useTranslations('payroll.historyRevisions'),router=useRouter();
 const [open,setOpen]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 async function revert(){setBusy(true);setError(null);try{const result=await revertHistoryUploadAction(attemptId);if(!result.ok)setError(result.error??t('failed'));else router.refresh();}catch{setError(t('failed'));}finally{setBusy(false);}}
 return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">{t('revert')}</h2><p className="text-sm text-muted-foreground">{t('revertHint')}</p>{!open?<button type="button" className="rounded-lg border px-4 py-2 text-sm font-medium" onClick={()=>setOpen(true)}>{t('reviewRevert')}</button>:<div className="space-y-3"><p className="text-sm">{t('revertConfirmation',{count})}</p><label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)} className="mt-1"/><span>{t('revertAcknowledgement')}</span></label><div className="flex gap-3"><button type="button" disabled={!confirmed||busy} className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:opacity-40" onClick={revert}>{busy?t('working'):t('revert')}</button><button type="button" disabled={busy} className="rounded-lg border px-4 py-2 text-sm" onClick={()=>{setOpen(false);setConfirmed(false);}}>{t('cancel')}</button></div></div>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</section>;
}
