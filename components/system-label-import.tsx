'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, ErrorBanner, tableWrapCls, thCls, theadCls, tbodyCls } from './ui';
import { LABEL_IMPORT_DEFINITIONS, ORGANISATION_LABEL_KINDS, type LabelImportPreview, type LabelImportPreviewRow } from '@/lib/system-label-definition';
import type { previewLabelsAction, importLabelsAction } from '@/app/(app)/admin/settings/system-labels/import-actions';

export function SystemLabelImport(_props:{companies?:{id:string;name:string}[];selectedCompanyIds?:string[]}={}) {
  const w=useTranslations('labelsImportWizard'),t=useTranslations('admin.systemLabels.excel'),tx=useTranslations('labelExcelRoundTrip'),tc=useTranslations('admin.systemLabels'),tp=useTranslations('admin.profileOptions'),tg=useTranslations('admin.benefitScheme'),router=useRouter();
  const category=(kind:string)=>(ORGANISATION_LABEL_KINDS as readonly string[]).includes(kind)?tc(`category.${kind}`):kind==='grades'?tc('category.grade'):kind==='grade_groups'?tg('groupsTitle'):tp(`category.${kind}`);
  const rowMessage=(row:LabelImportPreviewRow)=>row.reason==='required'&&row.reasonField?w('required',{field:w(`fields.${row.reasonField}`)}):w(row.reason==='required'?'invalidRow':row.reason??'invalidRow');
  const fileInput=useRef<HTMLInputElement>(null),stepHeading=useRef<HTMLHeadingElement>(null),importTrigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null);
  const [preview,setPreview]=useState<LabelImportPreview|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(false);
  const [summary,setSummary]=useState<{imported:number;updated:number;skipped:number;failed:number;errorReport?:string}|null>(null),[pending,start]=useTransition();
  const step=summary?3:preview?2:1,ready=preview?.rows.filter(row=>row.outcome==='add'&&row.selected).length??0,blocked=(preview?.rows.length??0)-ready;
  useEffect(()=>{if(open&&step>1)stepHeading.current?.focus();},[open,step]);
  const choose=(next:File|null)=>{
    setPreview(null);setSummary(null);setRetry(false);setError('');
    if(next&&(!/\.xlsx?$/i.test(next.name)||!next.size||next.size>5_000_000)){setFile(null);setError(w('fileError'));if(fileInput.current)fileInput.current.value='';return;}
    setFile(next);
  };
  const form=()=>{const data=new FormData();if(file)data.set('file',file);return data;};
  const request=async(operation:'preview'|'apply')=>{
    const data=form();data.set('operation',operation);if(preview)data.set('token',preview.token);
    const response=await fetch('/admin/settings/system-labels/import',{method:'POST',body:data,cache:'no-store'});
    if(!(response.headers.get('Content-Type')??'').includes('application/json'))throw new Error(w('requestFailed'));
    return response.json() as Promise<Awaited<ReturnType<typeof previewLabelsAction>>|Awaited<ReturnType<typeof importLabelsAction>>>;
  };
  const analyse=()=>start(async()=>{setError('');setSummary(null);try{const result=await request('preview');if(result.ok&&'preview' in result){setPreview(result.preview);setRetry(false);}else if(!result.ok)setError(result.message);}catch(error){setError(error instanceof Error?error.message:w('requestFailed'));}});
  const apply=()=>start(async()=>{
    if(!preview)return;setError('');
    try{const result=await request('apply');if(result.ok&&'summary' in result){setSummary(result.summary);setRetry(false);router.refresh();}else if(!result.ok){setError(result.message);setRetry(true);}}
    catch(error){setError(error instanceof Error?error.message:w('requestFailed'));setRetry(true);}
  });
  const errors=()=>start(async()=>{
    setError('');try{
      let blob:Blob;
      if(summary){if(!summary.errorReport)throw new Error(w('reportFailed'));blob=new Blob([Uint8Array.from(atob(summary.errorReport),character=>character.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}
      else{
        const response=await fetch('/admin/settings/system-labels/errors',{method:'POST',body:form(),cache:'no-store'});
        if(!response.ok||!(response.headers.get('Content-Type')??'').includes('spreadsheetml'))throw new Error(w('reportFailed'));
        blob=await response.blob();
      }
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='system-labels-errors.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError(error instanceof Error?error.message:w('reportFailed'));}
  });
  return <section className="space-y-3" data-label-import>
    <div className="flex flex-wrap justify-end gap-2">
      <a href="/admin/settings/system-labels/template" className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium">{tx('template')}</a>
      <Button ref={importTrigger} type="button" onClick={()=>{if(summary){setSummary(null);setPreview(null);setFile(null);setError('');}setOpen(true);}}>{t('import')}</Button>
    </div>
    <Dialog.Root open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/>
      <Dialog.Content onCloseAutoFocus={event=>{event.preventDefault();importTrigger.current?.focus();}} className="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[96vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <header className="flex items-start justify-between gap-4 p-5"><div><Dialog.Title className="text-lg font-semibold">{w('title')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{w('description')}</Dialog.Description></div><Dialog.Close asChild><Button type="button" variant="ghost" disabled={pending} aria-label={w('close')}>×</Button></Dialog.Close></header>
        <ol aria-label={w('steps')} className="grid grid-cols-3 gap-2 border-y border-border bg-muted/30 px-4 py-3 text-xs sm:text-sm">{[1,2,3].map(number=><li key={number} aria-current={step===number?'step':undefined} className={`flex items-center gap-2 ${step===number?'font-semibold text-primary':'text-muted-foreground'}`}><span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current">{number}</span>{w(`step${number}`)}</li>)}</ol>
        <div className="space-y-4 overflow-y-auto p-5" aria-busy={pending}>
          <div role={error?'alert':undefined}><ErrorBanner message={error}/></div>
          {step===1&&<div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-5"><section><h3 className="font-semibold">1. {w('template')}</h3><a href="/admin/settings/system-labels/template" className="mt-2 inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm font-medium">{tx('template')}</a></section><section><h3 className="font-semibold">2. {w('newOnly')}</h3><p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{w('warning')}</p></section></div>
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
            <div className={`${tableWrapCls} max-h-80 overflow-auto`}><table className="w-full min-w-[600px] text-sm"><thead className={theadCls}><tr>{['row','code','label','result'].map(key=><th key={key} className={thCls}>{w(key)}</th>)}</tr></thead><tbody className={tbodyCls}>{preview.rows.map(row=><tr key={row.sheet+':'+row.row} className={row.outcome!=='add'?'bg-muted/30':''}><td className="px-3 py-2 align-top">{categoryKnown(row.sheet)?category(row.sheet):row.sheet} · {row.row}</td><td className="max-w-48 break-all px-3 py-2 align-top font-mono text-xs">{row.after.Code??row.after.Name??'—'}</td><td className="max-w-48 break-words px-3 py-2 align-top">{row.after.Label??row.after.Name??'—'}</td><td className="max-w-80 px-3 py-2 align-top"><span className={row.outcome==='add'?'font-medium text-emerald-700 dark:text-emerald-300':'font-medium text-amber-800 dark:text-amber-200'}>{row.reason==='notSelected'?w('notSelectedStatus'):row.outcome==='add'?w('valid'):w('skipped')}</span>{row.outcome!=='add'&&<p className="mt-1 text-xs text-muted-foreground">{rowMessage(row)}</p>}{row.warnings?.map(warning=><p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}</td></tr>)}</tbody></table></div>
          </>}
          {step===3&&summary&&<><h3 ref={stepHeading} tabIndex={-1} className="font-semibold outline-none">{w('step3')}</h3><p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">{w('summary',{created:summary.imported,skipped:summary.skipped})}</p><p className="text-sm text-muted-foreground">{w('doneHelp')}</p></>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">{step===1?w('recognised'):step===2?w('onlyNew',{count:ready}):w('unchanged')}</p><div className="flex flex-wrap justify-end gap-2">
          {step===2&&<Button type="button" variant="secondary" disabled={pending} onClick={()=>{setPreview(null);setError('');setRetry(false);}}>{w('back')}</Button>}
          {(step===2&&blocked>0||step===3&&summary&&summary.skipped>0)&&<Button type="button" variant="outline" disabled={pending} onClick={errors}>{w('errorReport')}</Button>}
          {step===1&&<><Dialog.Close asChild><Button type="button" variant="secondary" disabled={pending}>{tc('cancel')}</Button></Dialog.Close><Button type="button" disabled={!file||pending} onClick={analyse}>{pending?t('working'):w('check')}</Button></>}
          {step===2&&(retry?<Button type="button" disabled={pending} onClick={analyse}>{pending?t('working'):w('checkAgain')}</Button>:<Button type="button" disabled={pending||!preview?.valid||!ready} onClick={apply}>{pending?w('importing'):w('importCount',{count:ready})}</Button>)}
          {step===3&&<Dialog.Close asChild><Button type="button" disabled={pending}>{w('step3')}</Button></Dialog.Close>}
        </div></footer>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </section>;
}
const categoryKnown=(kind:string)=>LABEL_IMPORT_DEFINITIONS.some(definition=>definition.kind===kind);
