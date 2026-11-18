'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {ActionButton} from '@/components/ui/action-button';
import {useUnsavedChangesGuard} from '@/components/ui/unsaved-changes';
import type {PayrollHistoryMaintenanceDetail,PayrollHistoryMaintenancePreview,PayrollHistoryMaintenanceRequest} from '@/lib/payroll-history-maintenance';
import type {BulkJobProgress} from '@/lib/bulk-job';
import {formatMoney} from '@/lib/money';
import {RevisionPreview} from './revision-preview';
import {HistoryJobPanel} from './history-job-progress';
import {previewHistoryMaintenanceAction,confirmHistoryMaintenanceAction} from './maintenance-actions';
import {maintenanceButton} from './maintenance-styles';
export function HistoryMaintenanceControl({detail,attemptId}:{detail?:PayrollHistoryMaintenanceDetail;attemptId?:string}){
 const t=useTranslations('payrollHistoryMaintenance'),router=useRouter();
 const [operation,setOperation]=useState<'edit'|'remove_items'|'remove_batch'>(detail?'edit':'remove_batch'),[reason,setReason]=useState(''),[amounts,setAmounts]=useState(()=>Object.fromEntries(detail?.items.map(item=>[item.key,item.amount])??[])),[selected,setSelected]=useState<Set<string>>(new Set());
 const [preview,setPreview]=useState<PayrollHistoryMaintenancePreview|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[jobId,setJobId]=useState<string|null>(null),[done,setDone]=useState(false);
 const previewHeading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{if(preview)previewHeading.current?.focus();},[preview]);
 const formAvailable=detail?!detail.unavailableReason&&(detail.canEdit||detail.canRemove):!!attemptId;
 const changed=detail?.items.filter(item=>amounts[item.key]!==item.amount)??[];
 useUnsavedChangesGuard(!done&&(!!reason||!!changed.length||!!selected.size||busy),t('unsaved'));
 const invalidate=()=>{setPreview(null);setConfirmed(false);setError('');setDone(false);};
 const finished=useCallback((job:BulkJobProgress)=>{setJobId(null);setBusy(false);setConfirmed(false);if(job.state==='completed'){setDone(true);router.refresh();}else{setError(job.error??t('failed'));setPreview(null);}},[router,t]);
 async function review(){
  if(busy||!reason.trim())return;setBusy(true);setError('');setPreview(null);setConfirmed(false);
  const input:PayrollHistoryMaintenanceRequest=operation==='remove_batch'?{version:1,operation,attemptId:attemptId!,reason:reason.trim()}:operation==='remove_items'?{version:1,operation,recordId:detail!.id,expectedRevisionId:detail!.currentRevisionId,itemKeys:[...selected],reason:reason.trim()}:{version:1,operation,recordId:detail!.id,expectedRevisionId:detail!.currentRevisionId,items:changed.map(item=>({key:item.key,amount:amounts[item.key]})),reason:reason.trim()};
  try{const result=await previewHistoryMaintenanceAction(input);if(result.ok)setPreview(result.result);else setError(result.error??t('failed'));}catch{setError(t('failed'));}finally{setBusy(false);}
 }
 async function apply(){if(!preview||busy||!confirmed)return;setBusy(true);setError('');let following=false;
  try{const result=await confirmHistoryMaintenanceAction({attemptId:preview.attemptId,previewHash:preview.plan.previewHash});if(!result.ok){setError(result.error??t('failed'));setPreview(null);setConfirmed(false);}else if('jobId'in result&&result.jobId){following=true;setJobId(result.jobId);}else{setDone(true);router.refresh();}}
  catch{setError(t('failed'));setPreview(null);setConfirmed(false);}finally{if(!following)setBusy(false);}
 }
 const available=operation==='edit'?!!detail?.canEdit&&!detail.withdrawn&&changed.length>0:operation==='remove_items'?!!detail?.canRemove&&selected.size>0:!!attemptId;
 const invalid=!!preview&&(preview.plan.counts.invalid>0||preview.plan.issues.length>0||!preview.plan.rows.some(row=>row.operation==='create'||row.operation==='replace'));
 return <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-5" aria-busy={busy} aria-label={t(detail?'maintainItems':'remove_batch')}>
  <header className="space-y-2"><h2 className="font-semibold">{t(detail?'maintainItems':'remove_batch')}</h2><p className="max-w-4xl text-sm text-muted-foreground">{t(detail?'itemHelp':'batchHelp')}</p></header>
  {detail?.unavailableReason&&<div role="status" className="space-y-2 rounded-lg border border-border p-3 text-sm"><p className="font-medium">{t('itemsUnavailable')}</p><p>{detail.unavailableReason}</p></div>}
  {detail&&<fieldset className="flex flex-wrap gap-x-5 gap-y-2" disabled={busy||done}><legend className="mb-2 text-sm font-medium">{t('operation')}</legend>{(['edit','remove_items'] as const).map(value=><label key={value} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="history-maintenance-operation" checked={operation===value} disabled={value==='edit'?!detail.canEdit:!detail.canRemove} onChange={()=>{setOperation(value);invalidate();}}/>{t(value)}</label>)}</fieldset>}
  {detail&&<div className="space-y-3">{detail.items.map(item=><article className="grid min-w-0 gap-3 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,12rem)]" key={item.key}>
   <div className="min-w-0 space-y-1"><h3 className="break-words text-sm font-medium">{item.code} · {item.label}</h3><p className="break-words text-xs text-muted-foreground">{t('originalCodes')}: {item.originalCodes.join(', ')||t('notRecorded')}</p><p className="text-sm tabular-nums">{t('current')}: {formatMoney(item.amount,detail.currency)}</p>{item.sourceAttemptId&&item.sourceName!==null&&<Link className="break-words text-xs text-primary underline" href={'/payroll/history-import/logs/'+item.sourceAttemptId}>{item.sourceName||t('log')}</Link>}{item.sourceAttemptId&&item.sourceName===null&&<p className="text-xs text-muted-foreground">{t('sourceLimited')}</p>}{!!item.sourceRows.length&&<p className="text-xs text-muted-foreground">{t('sourceRows',{rows:item.sourceRows.join(', ')})}</p>}{item.laterCorrection&&<p className="text-xs font-medium text-muted-foreground">{t('laterCorrectionRecorded')}</p>}</div>
   {operation==='edit'?<label className="min-w-0 text-sm">{t('newTotal',{code:item.code})}<input className="mt-1 block min-h-11 w-full rounded-lg border border-input bg-background px-3 tabular-nums" inputMode="decimal" value={amounts[item.key]??item.amount} disabled={busy||done||!detail.canEdit} maxLength={32} onChange={event=>{setAmounts(old=>({...old,[item.key]:event.target.value}));invalidate();}}/></label>:<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={busy||done||!detail.canRemove} checked={selected.has(item.key)} onChange={()=>{setSelected(old=>{const next=new Set(old);if(!next.delete(item.key))next.add(item.key);return next;});invalidate();}}/>{t('removeCode',{code:item.code})}</label>}
  </article>)}{!detail.items.length&&!detail.unavailableReason&&<p className="text-sm text-muted-foreground">{t('noItems')}</p>}</div>}
  {!done&&formAvailable&&<><label className="block text-sm font-medium">{t('reason')}<textarea className="mt-2 block min-h-24 w-full rounded-lg border border-input bg-background p-3 font-normal" value={reason} disabled={busy} required maxLength={2000} onChange={event=>{setReason(event.target.value);invalidate();}}/></label><ActionButton guardNavigation={false} type="button" aria-busy={busy&&!jobId} className={maintenanceButton} disabled={busy||!available||!reason.trim()} onClick={review}>{t('reviewChanges')}</ActionButton><button type="button" className={maintenanceButton+' ml-3'} disabled={busy} onClick={()=>{setAmounts(Object.fromEntries(detail?.items.map(item=>[item.key,item.amount])??[]));setSelected(new Set());setReason('');invalidate();}}>{t('resetChanges')}</button></>}
  {error&&<p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
  {preview&&<section className="min-w-0 space-y-4 border-t border-border pt-5" aria-label={t('preview')}><h3 ref={previewHeading} tabIndex={-1} className="font-semibold">{t('preview')}</h3><p className="break-words text-sm">{t('reason')}: {reason}</p><RevisionPreview plan={preview.plan}/>{!preview.plan.rows.some(row=>row.operation==='create'||row.operation==='replace')&&<p role="status" className="text-sm text-muted-foreground">{t('noChange')}</p>}<div className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm"><h4 className="font-medium">{t('impact')}</h4><p>{t('impactHelp')}</p><p>{t(operation==='remove_batch'?'batchHelp':'itemHelp')}</p></div>
   {!done&&formAvailable&&<><label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy||invalid} onChange={event=>setConfirmed(event.target.checked)}/><span>{t('confirmation')}</span></label><div className="flex flex-wrap gap-3"><ActionButton guardNavigation type="button" className={maintenanceButton+' bg-primary text-primary-foreground'} aria-busy={busy} disabled={busy||invalid||!confirmed||!available} onClick={apply}>{t('confirmChanges')}</ActionButton><button type="button" className={maintenanceButton} disabled={busy} onClick={()=>{setPreview(null);setConfirmed(false);}}>{t('backEdit')}</button></div></>}
   <Link className="inline-block break-words text-sm text-primary underline" href={'/payroll/history-import/logs/'+preview.attemptId}>{t('openReviewLog')}</Link>
  </section>}
  {jobId&&<HistoryJobPanel key={jobId} jobId={jobId} onFinished={finished}/>}{done&&<p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">{t('saved')}</p>}
 </section>;
}
