'use client';
import {useAssistantImportIntake} from '@/components/assistant/import-handoff';
import {useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {buildPayrollHistoryWorkbook,PAYROLL_HISTORY_XLSX_FILENAME} from '@/lib/import-template-xlsx';
import {PAYROLL_HISTORY_HEADERS} from '@/lib/payroll-history-import-schema';
import {historyRecordKey,type HistoryRevisionPlan} from '@/lib/payroll-history-revisions';
import {confirmHistoryUploadAction} from './workflow-actions';
import {RevisionPreview} from './revision-preview';

type Code={code:string;label:string;destination:string;direction:string};
const button='inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40';
export function HistoryWorkflow({codes}:{codes:Code[]}){
 const t=useTranslations('payroll.historyRevisions'),old=useTranslations('payroll.historyImport');
 const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<{attemptId:string;plan:HistoryRevisionPlan}|null>(null);
 const [busy,setBusy]=useState<'validate'|'confirm'|'template'|null>(null),[error,setError]=useState<string|null>(null),[confirmed,setConfirmed]=useState(false),[ticked,setTicked]=useState<Set<string>>(new Set()),[acknowledged,setAcknowledged]=useState(false),[skipped,setSkipped]=useState(0),[done,setDone]=useState(false);
 const operation=useRef<string|null>(null);
 async function validate(){
  if(!file||busy)return;setBusy('validate');setError(null);setDone(false);setConfirmed(false);setTicked(new Set());setAcknowledged(false);setSkipped(0);
  try{
   operation.current??=crypto.randomUUID();
   const response=await fetch('/payroll/history-import/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Upload-Operation':operation.current},body:file});
   const data=await response.json();if(!response.ok)throw new Error(data.error??t('failed'));
   setPreview(data);
  }catch(error){setError(error instanceof Error?error.message:t('failed'));}finally{setBusy(null);}
 }
 // d28501b8 r2 — replacements are chosen record by record. "Import new records only" ticks none.
 async function commit(mode:'all'|'ticked'|'new'){
  if(!preview||busy)return;setBusy('confirm');setError(null);
  const selection=mode==='ticked'?{confirmReplacement:true,selectedRecordKeys:[...ticked],acknowledgeWarnings:acknowledged}:mode==='new'?{confirmReplacement:false,skipReplacements:true}:{confirmReplacement:false};
  try{const result=await confirmHistoryUploadAction({attemptId:preview.attemptId,previewHash:preview.plan.previewHash,...selection});if(!result.ok)setError(result.error??t('failed'));else{setSkipped(result.result.skippedReplacements??0);setDone(true);}}catch{setError(t('failed'));}finally{setBusy(null);}
 }
 async function template(){
  setBusy('template');setError(null);
  try{const bytes=await buildPayrollHistoryWorkbook({title:old('codeReference'),note:old('codeReferenceHint'),code:old('colCode'),label:old('colCodeLabel'),destination:old('colDestination'),direction:old('colDirection'),
    category:old('colCategory'),amountType:old('colAmountType'),sampleNote:old('sampleNote'),
    categoryNames:{basic:old('categories.basic'),earning:old('categories.earning'),deduction:old('categories.deduction'),employeeStatutory:old('categories.employeeStatutory'),employerStatutory:old('categories.employerStatutory'),payrollTotal:old('categories.payrollTotal')},
    amountTypeNames:{employee:old('amountTypes.employee'),employer:old('amountTypes.employer'),check:old('amountTypes.check')}},codes);
   const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),link=document.createElement('a');link.href=url;link.download=PAYROLL_HISTORY_XLSX_FILENAME;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch{setError(t('failed'));}finally{setBusy(null);}
 }
 useAssistantImportIntake('payroll_history',text=>{setFile(new File([text],'assistant-prepared.csv',{type:'text/csv'}));setPreview(null);operation.current=null;setDone(false);},setError);
 const replaceable=preview?preview.plan.rows.filter(row=>row.operation==='replace'):[];
 const tickedWarnings=[...new Set(replaceable.filter(row=>ticked.has(historyRecordKey(row))).flatMap(row=>row.warnings??[]))];
 const blocked=!preview||busy!==null||!confirmed||preview.plan.counts.invalid>0||preview.plan.issues.length>0;
 return <div className="space-y-6" aria-busy={busy!==null}>
  <section className="space-y-4 rounded-xl border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold">{t('fileTitle')}</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('fileHint')}</p></div><button type="button" onClick={template} disabled={busy!==null} className={button}>{busy==='template'?t('working'):t('template')}</button></div>
   <p className="text-xs text-muted-foreground">{PAYROLL_HISTORY_HEADERS.join(' · ')}</p>
   <label className="block text-sm font-medium">{t('file')}<input type="file" accept=".csv,.xls,.xlsx" disabled={busy!==null} className="mt-2 block w-full rounded-lg border p-3 text-sm" onChange={event=>{setFile(event.target.files?.[0]??null);operation.current=null;setPreview(null);setDone(false);setError(null);}}/></label>
   {file&&file.size>10*1024*1024&&<p role="alert" className="text-sm text-destructive">{t('tooLarge')}</p>}
   <button type="button" onClick={validate} disabled={!file||file.size>10*1024*1024||busy!==null} className={button+' bg-primary text-primary-foreground'}>{busy==='validate'?t('validating'):t('validate')}</button>
  </section>
  {error&&<p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}</p>}
  {preview&&<section className="space-y-5 rounded-xl border bg-card p-5"><div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">{done?t('results'):t('preview')}</h2><Link className="text-sm font-medium text-primary underline" href={'/payroll/history-import/logs/'+preview.attemptId}>{t('openLog')}</Link></div>
   <RevisionPreview key={preview.attemptId} plan={preview.plan} selection={done||!replaceable.length?undefined:{ticked,toggle:key=>setTicked(prev=>{const next=new Set(prev);if(!next.delete(key))next.add(key);return next;}),
    toggleAll:on=>setTicked(on?new Set(replaceable.map(historyRecordKey)):new Set())}}/>
   {done?<p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">{t('success')}{skipped>0&&<> {t('successSkipped',{count:skipped})}</>}</p>:<div className="space-y-3 border-t pt-4"><p className="text-sm text-muted-foreground">{t('atomicHint')}</p>
    {replaceable.length>0&&<div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-50/40 p-4 text-sm dark:bg-amber-500/5">
     {ticked.size===0?<p>{t('tickHint')}</p>:<>
      <p className="font-medium">{t('tickedTitle',{count:ticked.size})}</p>
      {tickedWarnings.length>0&&<><p>{t('warningsTitle')}</p><ul className="list-disc space-y-1 pl-5">{tickedWarnings.map(w=><li key={w}>{w}</li>)}</ul></>}
      <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} disabled={busy!==null}/><span>{t('acknowledge')}</span></label>
     </>}
    </div>}
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy!==null}/><span>{t('confirmation')}</span></label>
    <div className="flex flex-wrap gap-3">
     {replaceable.length>0?<>
      <button type="button" className={button+' bg-primary text-primary-foreground'} onClick={()=>commit('ticked')} disabled={blocked||ticked.size===0||!acknowledged}>{busy==='confirm'?t('importing'):t('confirmOverwrite')}</button>
      {preview.plan.counts.created>0&&<button type="button" className={button} onClick={()=>commit('new')} disabled={blocked}>{t('importNewOnly')}</button>}
     </>:<button type="button" className={button+' bg-primary text-primary-foreground'} onClick={()=>commit('all')} disabled={blocked}>{busy==='confirm'?t('importing'):t('import')}</button>}
     <button type="button" className={button} onClick={()=>{setPreview(null);setConfirmed(false);setTicked(new Set());setAcknowledged(false);operation.current=null;}} disabled={busy!==null}>{t('cancel')}</button></div>
   </div>}
  </section>}
 </div>;
}
