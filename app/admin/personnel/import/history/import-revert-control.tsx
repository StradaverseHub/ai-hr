'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import {IMPORT_REVERT_REASON_MAX,normalizeImportRevertReason} from '@/lib/import-history';
import {previewImportRevertAction,revertImportAction} from './actions';
import type {ImportRevertJobProgress} from '@/lib/import-revert-job';
type Preview=Extract<Awaited<ReturnType<typeof previewImportRevertAction>>,{ok:true}>['result'];
type Blocker={itemId:string;label:string;reason:string};
/** What a revert will restore, for any kind: rows when the kind restores a set, otherwise its fields. */
export function RestoreSummary({restore}:{restore:unknown}){
 const t=useTranslations('people.importHistory');
 if(!restore||typeof restore!=='object')return null;
 const value=restore as {operation?:string;rows?:{code:string;label?:string;percentage:string}[];fields?:{field:string;value:string}[];void?:boolean};
 // 524303d9 — an "Everything — new employees" revert voids the employee the import created (ADR-0157).
 if(value.void===true)return <p className="text-xs">{t('employeeFull.willVoid')}</p>;
 if(Array.isArray(value.rows))return value.rows.length?<ul className="text-xs">{value.rows.map((r,i)=><li key={i}>{r.code}{r.label&&r.label!==r.code?` (${r.label})`:''} · {r.percentage}%</li>)}</ul>:<p className="text-xs">{t('allocation.clear')}</p>;
 if(Array.isArray(value.fields))return <ul className="text-xs">{value.fields.map((f,i)=><li key={i}>{f.field}: {f.value}</li>)}</ul>;
 return null;
}
/** Reusable revert confirmation (ADR-0155): review, blockers, reason, acknowledgement, once-only confirm. */
export function ImportRevertControl({attemptId,activeJobId}:{attemptId:string;activeJobId?:string|null}){
 const t=useTranslations('people.importHistory'),router=useRouter();
 const[preview,setPreview]=useState<Preview|null>(null),[blockers,setBlockers]=useState<Blocker[]>([]),[reason,setReason]=useState(''),[acknowledged,setAcknowledged]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 // A movement import revert runs in the background: the control stays busy until the job reports its outcome.
 const[jobId,setJobId]=useState<string|null>(activeJobId??null);
 useEffect(()=>{
  if(!jobId)return;
  let alive=true,timer:ReturnType<typeof setTimeout>;setBusy(true);
  const poll=async()=>{
   try{
    const response=await fetch(`/admin/personnel/import/history/revert-jobs/${jobId}`,{cache:'no-store'});
    const payload=await response.json().catch(()=>null) as {job?:ImportRevertJobProgress}|null;
    const job=payload?.job;
    if(!alive)return;
    if(!response.ok||!job){setJobId(null);setBusy(false);setError(t('revert.failed'));return;}
    if(job.state==='completed'){setJobId(null);setBusy(false);close();router.refresh();return;}
    if(job.state==='failed'||job.state==='cancelled'){setJobId(null);setBusy(false);close();setError(job.error??t('revert.failed'));setBlockers(job.blockers);return;}
   }catch{/* keep polling: the job is durable */}
   if(alive)timer=setTimeout(poll,1500);
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[jobId]);
 const close=()=>{setPreview(null);setReason('');setAcknowledged(false);};
 async function review(){setBusy(true);setError(null);setBlockers([]);close();try{const r=await previewImportRevertAction(attemptId);if(!r.ok){setError(r.error??t('revert.failed'));setBlockers(r.blockers);}else{setPreview(r.result);setBlockers(r.result.blockers);}}catch{setError(t('revert.failed'));}finally{setBusy(false);}}
 async function revert(){if(!preview)return;setBusy(true);setError(null);let handedOff=false;try{const r=await revertImportAction(attemptId,preview.previewHash,reason);if(!r.ok){setError(r.error??t('revert.failed'));setBlockers(r.blockers);close();}else if('job' in r.result){handedOff=true;setJobId(r.result.job.id);}else router.refresh();}catch{setError(t('revert.failed'));close();}finally{if(!handedOff)setBusy(false);}}
 const validReason=normalizeImportRevertReason(reason)!==null;
 return <section className="space-y-3 rounded-xl border p-5" aria-label={t('revert.title')}>
  <h2 className="font-semibold">{t('revert.title')}</h2><p className="text-sm text-muted-foreground">{t('revert.hint')}</p>
  {!preview&&<button type="button" className="min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40" disabled={busy} aria-busy={busy} onClick={review}>{busy?t('revert.working'):t('revert.review')}</button>}
  {blockers.length>0&&<div role="alert" className="space-y-1 text-sm"><p className="font-medium text-destructive">{t('revert.blocked')}</p><ul className="list-disc pl-5">{blockers.map((b,i)=><li key={i}><span className="font-medium">{b.label}</span>: {b.reason}</li>)}</ul></div>}
  {preview&&preview.eligible&&<div className="space-y-3">
   <h3 className="text-sm font-medium">{t('revert.restoreTitle')}</h3>
   <ul className="divide-y rounded-lg border text-sm">{preview.items.map(item=><li key={item.itemId} className="space-y-1 p-3"><p className="font-medium">{item.label}</p><RestoreSummary restore={item.restore}/></li>)}</ul>
   <label className="block space-y-1 text-sm"><span className="font-medium">{t('revert.reason')}</span><textarea className={`${inputCls} h-auto py-2`} rows={3} maxLength={IMPORT_REVERT_REASON_MAX} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/><span className="block text-xs text-muted-foreground">{t('revert.reasonHint')}</span></label>
   <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy} onChange={e=>setAcknowledged(e.target.checked)}/><span>{t('revert.acknowledge')}</span></label>
   <div className="flex gap-3"><button aria-busy={busy} type="button" className="min-h-11 rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive disabled:opacity-40" disabled={busy||!acknowledged||!validReason} onClick={revert}>{busy?t('revert.working'):t('revert.confirm')}</button><button aria-busy={busy} type="button" className="min-h-11 rounded-lg border px-4 py-2 text-sm" disabled={busy} onClick={close}>{t('revert.cancel')}</button></div>
  </div>}
  {preview&&!preview.eligible&&<button aria-busy={busy} type="button" className="min-h-11 rounded-lg border px-4 py-2 text-sm" disabled={busy} onClick={()=>{close();setBlockers([]);}}>{t('revert.cancel')}</button>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </section>;
}
