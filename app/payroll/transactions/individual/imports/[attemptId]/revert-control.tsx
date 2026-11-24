'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {revertIndividualImportAction} from '../../../import-excel/individual-actions';
/** `batch` is the readable batch label (board 8d02748a); the action still sends the full internal id.
 *  0ec0ee00 — a queued batch is reverted by the background worker in steps; the Import Log shows its progress. */
export function IndividualImportRevert({id,batch,file,count}:{id:string;batch:string;file:string;count:number}){
 const t=useTranslations('payroll.individualImport'),router=useRouter();const [confirm,setConfirm]=useState(false),[processed,setProcessed]=useState(false),[error,setError]=useState(''),[queued,setQueued]=useState(false),[busy,start]=useTransition();
 return <section className="space-y-4 rounded-xl border border-border p-5"><h2 className="font-semibold">{t('revert')}</h2><p>{t('revertWarning',{batch,file,count})}</p><p className="text-sm text-muted-foreground">{t('revertControls')}</p><label className="flex gap-3 text-sm"><input type="checkbox" checked={confirm} disabled={busy||queued} onChange={e=>setConfirm(e.target.checked)}/>{t('revertConfirm')}</label><label className="flex gap-3 text-sm"><input type="checkbox" checked={processed} disabled={busy||queued} onChange={e=>setProcessed(e.target.checked)}/>{t('processedConfirm')}</label>{error&&<p role="alert" className="text-destructive">{error}</p>}{queued&&<p role="status">{t('revertQueued')}</p>}<Button aria-busy={busy} type="button" disabled={busy||queued||!confirm} onClick={()=>start(async()=>{setError('');try{const result=await revertIndividualImportAction({id,confirmProcessed:processed});if(!result.ok)throw new Error(result.error);if(result.data.queued)setQueued(true);router.refresh();}catch(e){const key=e instanceof Error?e.message:'';setError(t.has(key)?t(key as never):t('revertFailed'));}})}>{busy?t('working'):t('revert')}</Button></section>;
}
