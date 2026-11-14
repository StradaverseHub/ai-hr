'use client';

import { ExportDownloadLink } from '@/components/export-download-link';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, ErrorBanner, tableWrapCls, thCls, theadCls, tbodyCls } from './ui';
import type { LabelImportPreview } from '@/lib/system-label-definition';
import { ImportProblemTable } from './import-problem-table';
import type { ImportProblemLine } from '@/lib/import-problem-lines';
import { labelCategoryCaption, labelImportProblemLines, type LabelProblemTranslator } from '@/lib/system-label-import-problems';
import type { previewLabelsAction, importLabelsAction } from '@/app/admin/settings/system-labels/import-actions';
import { SystemLabelImportJobPanel } from './system-label-import-progress';
import { SYSTEM_LABEL_IMPORT_ALREADY_RUNNING, systemLabelImportActive, type SystemLabelImportProgress } from '@/lib/system-label-import-job';

const subscribeHydration=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;

export function SystemLabelImport(_props:{companies?:{id:string;name:string}[];selectedCompanyIds?:string[]}={}) {
  const exchange=useTranslations('systemLabelExchange');
  const w=useTranslations('labelsImportWizard'),t=useTranslations('admin.systemLabels.excel'),tx=useTranslations('labelExcelRoundTrip'),tc=useTranslations('admin.systemLabels'),router=useRouter();
  // Board c074c6b8: every problem the wizard shows is a line from the same adapter the Error Log is built from.
  const root=useTranslations() as unknown as LabelProblemTranslator;
  const fileInput=useRef<HTMLInputElement>(null),stepHeading=useRef<HTMLHeadingElement>(null),importTrigger=useRef<HTMLButtonElement>(null);
  // The server button cannot accept a click before this wizard's React boundary owns it.
  const hydrated=useSyncExternalStore(subscribeHydration,clientSnapshot,serverSnapshot);
  const [open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null);
  const [preview,setPreview]=useState<LabelImportPreview|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(false);
  const [summary,setSummary]=useState<{imported:number;updated:number;skipped:number;failed:number;errorReport?:string}|null>(null),[pending,start]=useTransition();
  // The background import (it keeps running when the dialog closes or the page changes, and is rejoined here).
  const [job,setJob]=useState<SystemLabelImportProgress|null>(null),jobKey=useRef('');
  // The finished import's own problem lines, read back from what its worker stored (never re-checked).
  const [outcome,setOutcome]=useState<{jobId:string;failed:boolean;lines:ImportProblemLine[];total:number;legacy:boolean}|null>(null),[outcomeError,setOutcomeError]=useState(false);
  const step=summary||job?3:preview?2:1,ready=preview?.rows.filter(row=>row.outcome==='add'&&row.selected).length??0,blocked=(preview?.rows.length??0)-ready;
  const checkProblems=useMemo(()=>preview?labelImportProblemLines(preview.rows,root):[],[preview,root]);
  useEffect(()=>{if(open&&step>1)stepHeading.current?.focus();},[open,step]);
  useEffect(()=>{
    let alive=true;
    fetch('/admin/settings/system-labels/import/jobs',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(p=>{if(alive&&p?.jobs){const active=(p.jobs as SystemLabelImportProgress[]).find(item=>systemLabelImportActive(item.state));if(active)setJob(active);}}).catch(()=>undefined);
    return()=>{alive=false;};
  },[]);
  const finished=useCallback((done:SystemLabelImportProgress)=>{
    // The outcome is shown where the synchronous import showed it: the wizard's summary (reopened if it was closed).
    setJob(null);jobKey.current='';setOpen(true);setOutcome(null);setOutcomeError(false);
    const failed=!(done.state==='completed'&&done.result);
    if(done.state==='completed'||done.state==='failed')fetch(`/admin/settings/system-labels/import/jobs/${done.id}/errors`,{cache:'no-store'})
      .then(async response=>{if(!response?.ok)throw new Error('unavailable');const body=await response.json() as {lines:ImportProblemLine[];total:number;legacy:boolean};setOutcome({jobId:done.id,failed,lines:body.lines,total:body.total,legacy:body.legacy});})
      .catch(()=>setOutcomeError(true));
    if(!failed&&done.result){setSummary(done.result);setRetry(false);router.refresh();return;}
    setError(done.error||w('job.state.failed'));setRetry(true);
  },[router,w]);
  const choose=(next:File|null)=>{
    setPreview(null);setSummary(null);setOutcome(null);setOutcomeError(false);jobKey.current='';setRetry(false);setError('');
    if(next&&(!/\.xlsx?$/i.test(next.name)||!next.size||next.size>5_000_000)){setFile(null);setError(w('fileError'));if(fileInput.current)fileInput.current.value='';return;}
    setFile(next);
  };
  const form=()=>{const data=new FormData();if(file)data.set('file',file);return data;};
  const request=async(operation:'preview'|'apply')=>{
    const data=form();data.set('operation',operation);if(preview)data.set('token',preview.token);
    // One key per confirmed preview, so a repeated click or a retried request rejoins the same background import.
    if(operation==='apply'){if(!jobKey.current)jobKey.current=crypto.randomUUID();data.set('operationKey',jobKey.current);}
    const response=await fetch('/admin/settings/system-labels/import',{method:'POST',body:data,cache:'no-store'});
    if(!(response.headers.get('Content-Type')??'').includes('application/json'))throw new Error(w('requestFailed'));
    return response.json() as Promise<Awaited<ReturnType<typeof previewLabelsAction>>|Awaited<ReturnType<typeof importLabelsAction>>>;
  };
  const analyse=()=>start(async()=>{setError('');setSummary(null);setOutcome(null);setOutcomeError(false);try{const result=await request('preview');if(result.ok&&'preview' in result){setPreview(result.preview);setRetry(false);}else if(!result.ok)setError(result.message);}catch(error){setError(error instanceof Error?error.message:w('requestFailed'));}});
  const apply=()=>start(async()=>{
    if(!preview)return;setError('');
    try{const result=await request('apply');if(result.ok&&'job' in result){setJob(result.job);setRetry(false);}else if(!result.ok){setError(result.message===SYSTEM_LABEL_IMPORT_ALREADY_RUNNING?w('job.otherRunning'):result.message);setRetry(true);jobKey.current='';}}
    catch(error){setError(error instanceof Error?error.message:w('requestFailed'));setRetry(true);}
  });
  const errors=()=>start(async()=>{
    setError('');try{
      let blob:Blob;
      if(summary&&(!outcome||outcome.legacy)){
        // An import finished before board c074c6b8 kept its rows: its stored report is the only copy.
        if(!summary.errorReport)throw new Error(w('reportFailed'));blob=new Blob([Uint8Array.from(atob(summary.errorReport),character=>character.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      }else if(summary&&outcome){
        const response=await fetch(`/admin/settings/system-labels/import/jobs/${outcome.jobId}/errors?format=xlsx`,{cache:'no-store'});
        if(!response.ok||!(response.headers.get('Content-Type')??'').includes('spreadsheetml'))throw new Error(w('reportFailed'));
        blob=await response.blob();
      }else{
        const response=await fetch('/admin/settings/system-labels/errors',{method:'POST',body:form(),cache:'no-store'});
        if(!response.ok||!(response.headers.get('Content-Type')??'').includes('spreadsheetml'))throw new Error(w('reportFailed'));
        blob=await response.blob();
      }
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='system-labels-errors.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError(error instanceof Error?error.message:w('reportFailed'));}
  });
  return <section className="space-y-3" data-label-import>
    <p className="text-sm text-muted-foreground">{exchange('scopeHelp')}</p>
    <div className="flex flex-wrap justify-end gap-2">
      <ExportDownloadLink href="/admin/settings/system-labels/template" className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium">{tx('template')}</ExportDownloadLink>
      {job&&!open&&<div className="w-full"><SystemLabelImportJobPanel key={job.id} job={job} onFinished={finished}/></div>}
      <Button ref={importTrigger} type="button" disabled={!hydrated} data-label-import-ready={hydrated?'true':'false'} onClick={()=>{if(summary){setSummary(null);setPreview(null);setFile(null);setError('');setOutcome(null);setOutcomeError(false);jobKey.current='';}setOpen(true);}}>{t('import')}</Button>
    </div>
    <Dialog.Root open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/>
      <Dialog.Content onCloseAutoFocus={event=>{event.preventDefault();importTrigger.current?.focus();}} className="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[96vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <header className="flex items-start justify-between gap-4 p-5"><div><Dialog.Title className="text-lg font-semibold">{w('title')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{w('description')}</Dialog.Description></div><Dialog.Close asChild><Button aria-busy={pending} type="button" variant="ghost" disabled={pending} aria-label={w('close')}>×</Button></Dialog.Close></header>
        <ol aria-label={w('steps')} className="grid grid-cols-3 gap-2 border-y border-border bg-muted/30 px-4 py-3 text-xs sm:text-sm">{[1,2,3].map(number=><li key={number} aria-current={step===number?'step':undefined} className={`flex items-center gap-2 ${step===number?'font-semibold text-primary':'text-muted-foreground'}`}><span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current">{number}</span>{w(`step${number}`)}</li>)}</ol>
        <div className="space-y-4 overflow-y-auto p-5" aria-busy={pending}>
          <div role={error?'alert':undefined}><ErrorBanner message={error}/></div>
          {step===1&&<div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-5"><section><h3 className="font-semibold">1. {w('template')}</h3><ExportDownloadLink href="/admin/settings/system-labels/template" className="mt-2 inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm font-medium">{tx('template')}</ExportDownloadLink></section><section><h3 className="font-semibold">2. {w('newOnly')}</h3><p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{w('warning')}</p></section></div>
            <section><h3 className="font-semibold">3. {w('upload')}</h3><label className={`relative mt-2 flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary/40 bg-muted/20 p-5 text-center focus-within:ring-2 focus-within:ring-primary ${pending?'pointer-events-none opacity-60':''}`} onDragOver={event=>{event.preventDefault();}} onDrop={event=>{event.preventDefault();if(!pending)choose(event.dataTransfer.files[0]??null);}}>
              <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-primary"><path d="M7 18H5a4 4 0 0 1-.7-7.94 7 7 0 0 1 13.43-1.48A4.5 4.5 0 0 1 19 17.9h-2M12 21V10m-4 4 4-4 4 4"/></svg>
              <span className="font-medium">{w('drop')}</span><span className="text-xs text-muted-foreground">{w('accepts')}</span><span className="text-xs text-muted-foreground">{w('maximum')}</span>
              <input ref={fileInput} aria-label={w('upload')} type="file" accept=".xlsx,.xls" disabled={pending} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={event=>choose(event.target.files?.[0]??null)}/>
            </label>{file&&<p className="mt-2 break-all text-sm" role="status">{file.name} · {new Intl.NumberFormat().format(file.size)} {w('bytes')}</p>}</section>
          </div>}
          {step===2&&preview&&<>
            <h3 ref={stepHeading} tabIndex={-1} className="font-semibold outline-none">{ready?w('review'):w('allBlocked')}</h3>
            <div className="flex flex-wrap gap-2 text-sm" role="status"><p className="rounded-lg border border-border px-3 py-2">{w('checked',{count:preview.rows.length})}</p><p className="rounded-lg border border-border px-3 py-2 text-emerald-700 dark:text-emerald-300">{w('ready',{count:ready})}</p><p className="rounded-lg border border-border px-3 py-2 text-amber-800 dark:text-amber-200">{w('blocked',{count:blocked})}</p></div>
            {!ready&&<p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{w('nothing')}</p>}
            {ready>0&&<div className={`${tableWrapCls} max-h-80 overflow-auto`}><table className="w-full min-w-[600px] text-sm"><thead className={theadCls}><tr>{['row','code','label','assignment','result'].map(key=><th key={key} className={thCls}>{key==='assignment'?exchange('assignment'):w(key)}</th>)}</tr></thead><tbody className={tbodyCls}>{preview.rows.filter(row=>row.outcome==='add'&&row.selected).map(row=><tr key={row.sheet+':'+row.row}><td className="px-3 py-2 align-top">{labelCategoryCaption(row.sheet,root)} · {row.row}</td><td className="max-w-48 break-all px-3 py-2 align-top font-mono text-xs">{row.after.Code||row.after.Name||'—'}</td><td className="max-w-48 break-words px-3 py-2 align-top">{row.after.Label||row.after.Name||'—'}</td><td className="max-w-64 break-words px-3 py-2 align-top">{row.after.Criteria==='global'?exchange('global'):(row.after['Criteria Companies']||row.after.Company||'—')}</td><td className="max-w-80 px-3 py-2 align-top"><span className="font-medium text-emerald-700 dark:text-emerald-300">{w('valid')}</span>{row.warnings?.length?<p className="text-xs text-muted-foreground">{root('labelsImportWizard.problem.legacyHeaders')}</p>:null}</td></tr>)}</tbody></table></div>}
            {checkProblems.length>0&&<section className="space-y-2" aria-label={w('problemsTitle')}><h4 className="text-sm font-semibold">{w('problemsTitle')}</h4><div className="max-h-96 overflow-auto"><ImportProblemTable lines={checkProblems} caption={w('problemsTitle')}/></div></section>}
            {outcome?.failed&&outcome.lines.length>0&&<section className="space-y-2" aria-label={w('stoppedTitle')}><h4 className="text-sm font-semibold">{w('stoppedTitle')}</h4><ImportProblemTable lines={outcome.lines} total={outcome.total} caption={w('stoppedTitle')}/></section>}
          </>}
          {step===3&&job&&!summary&&<><h3 ref={stepHeading} tabIndex={-1} className="font-semibold outline-none">{w('importing')}</h3><SystemLabelImportJobPanel key={job.id} job={job} onFinished={finished}/></>}
          {step===3&&summary&&<><h3 ref={stepHeading} tabIndex={-1} className="font-semibold outline-none">{w('step3')}</h3><p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">{w('summary',{created:summary.imported,skipped:summary.skipped})}</p>{summary.failed>0&&<p role="status" className="text-sm text-destructive">{exchange('failedRows',{count:summary.failed})}</p>}<p className="text-sm text-muted-foreground">{w('doneHelp')}</p>
            {outcome&&!outcome.failed&&outcome.lines.length>0&&<section className="space-y-2" aria-label={w('problemsTitle')}><h4 className="text-sm font-semibold">{w('problemsTitle')}</h4><div className="max-h-96 overflow-auto"><ImportProblemTable lines={outcome.lines} total={outcome.total} caption={w('problemsTitle')}/></div></section>}
            {outcomeError&&(summary.skipped>0||summary.failed>0)&&<p role="status" className="text-sm text-muted-foreground">{w('problemsUnavailable')}</p>}</>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">{step===1?w('recognised'):step===2?w('onlyNew',{count:ready}):job&&!summary?w('job.backgroundHelp'):w('unchanged')}</p><div className="flex flex-wrap justify-end gap-2">
          {step===2&&<Button aria-busy={pending} type="button" variant="secondary" disabled={pending} onClick={()=>{setPreview(null);setError('');setRetry(false);setOutcome(null);setOutcomeError(false);}}>{w('back')}</Button>}
          {(step===2&&blocked>0||step===3&&summary&&(summary.skipped>0||summary.failed>0))&&<Button aria-busy={pending} type="button" variant="outline" disabled={pending} onClick={errors}>{w('errorReport')}</Button>}
          {step===1&&<><Dialog.Close asChild><Button aria-busy={pending} type="button" variant="secondary" disabled={pending}>{tc('cancel')}</Button></Dialog.Close><Button aria-busy={pending} type="button" disabled={!file||pending} onClick={analyse}>{pending?t('working'):w('check')}</Button></>}
          {step===2&&(retry?<Button aria-busy={pending} type="button" disabled={pending} onClick={analyse}>{pending?t('working'):w('checkAgain')}</Button>:<Button aria-busy={pending} type="button" disabled={pending||!preview?.valid||!ready} onClick={apply}>{pending?w('importing'):w('importCount',{count:ready})}</Button>)}
          {step===3&&<Dialog.Close asChild><Button aria-busy={pending} type="button" disabled={pending}>{job&&!summary?w('close'):w('step3')}</Button></Dialog.Close>}
        </div></footer>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </section>;
}
