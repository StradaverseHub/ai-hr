'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, ErrorBanner, inputCls, tableWrapCls, thCls, theadCls, tbodyCls } from './ui';
import { LABEL_IMPORT_DEFINITIONS, ORGANISATION_LABEL_KINDS, type LabelImportMode, type LabelImportPreview } from '@/lib/system-label-definition';
import { previewLabelsAction, importLabelsAction } from '@/app/admin/settings/system-labels/import-actions';

export function SystemLabelImport({companies=[],selectedCompanyIds=[]}:{companies?:{id:string;name:string}[];selectedCompanyIds?:string[]}={}) {
  const t=useTranslations('admin.systemLabels.excel'),tx=useTranslations('labelExcelRoundTrip'),tc=useTranslations('admin.systemLabels'),tp=useTranslations('admin.profileOptions'),tg=useTranslations('admin.benefitScheme'),router=useRouter();
  const [exportOpen,setExportOpen]=useState(false),[exportPending,setExportPending]=useState(false),[exportError,setExportError]=useState('');
  const [selectedKeys,setSelectedKeys]=useState<string[]|null>(null),[previewDirty,setPreviewDirty]=useState(false);
  const category=(kind:string)=>(ORGANISATION_LABEL_KINDS as readonly string[]).includes(kind)?tc(`category.${kind}`):kind==='grades'?tc('category.grade'):kind==='grade_groups'?tg('groupsTitle'):tp(`category.${kind}`);
  const fileInput=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null),[mode,setMode]=useState<LabelImportMode>('add');
  const [preview,setPreview]=useState<LabelImportPreview|null>(null),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [summary,setSummary]=useState<{imported:number;updated:number;skipped:number;failed:number}|null>(null),[pending,start]=useTransition();
  const reset=()=>{setPreview(null);setConfirmed(false);setSummary(null);setError('');setSelectedKeys(null);setPreviewDirty(false);};
  const form=()=>{const d=new FormData();if(file)d.set('file',file);d.set('mode',mode);if(selectedKeys)d.set('selectedKeys',JSON.stringify(selectedKeys));return d;};
  const analyse=()=>start(async()=>{setError('');setConfirmed(false);setSummary(null);const r=await previewLabelsAction(form());if(r.ok){setPreview(r.preview);setMode(r.preview.mode??mode);setSelectedKeys(r.preview.rows.filter(row=>row.selected).map(row=>row.sheet+':'+row.row));setPreviewDirty(false);}else setError(r.message);});
  const apply=()=>start(async()=>{
    if(!preview)return;
    const d=form();d.set('token',preview.token);d.set('confirmUpdates',String(confirmed));
    const r=await importLabelsAction(d);
    if(r.ok){setSummary(r.summary);setSelectedKeys(null);setPreviewDirty(false);setPreview(null);setFile(null);if(fileInput.current)fileInput.current.value='';router.refresh();}
    else {setError(r.message);setPreview(null);setConfirmed(false);}
  });
  const updates=preview?.rows.some(r=>selectedKeys?.includes(r.sheet+':'+r.row)&&r.outcome==='update')??false;
  const selectRow=(key:string,checked:boolean)=>{setSelectedKeys(old=>checked?[...(old??[]),key]:(old??[]).filter(k=>k!==key));setPreviewDirty(true);setConfirmed(false);};
  const download=async(e:React.FormEvent<HTMLFormElement>)=>{
   e.preventDefault();setExportError('');setExportPending(true);
   try{
    const d=new FormData(e.currentTarget),q=new URLSearchParams();for(const [key,value]of d)q.append(key,String(value));
    const response=await fetch('/admin/settings/system-labels/current-data?'+q.toString(),{cache:'no-store'});
    if(!response.ok){const data=await response.json();throw new Error(data.error??tx('downloadFailed'));}
    if(!(response.headers.get('Content-Type')??'').includes('spreadsheetml'))throw new Error(tx('downloadFailed'));
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=/filename="([^"]+)"/.exec(response.headers.get('Content-Disposition')??'')?.[1]??'system-labels.xlsx';
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportOpen(false);
   }catch(e){setExportError(e instanceof Error?e.message:tx('downloadFailed'));}finally{setExportPending(false);}
  };
  return <section className="space-y-3" data-label-import>
    <div className="flex flex-wrap justify-end gap-2">
      <a href="/admin/settings/system-labels/template" className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium">{tx('blank')}</a>
      <Button type="button" variant="outline" onClick={()=>{setExportError('');setExportOpen(true);}}>{tx('current')}</Button>
      <Button type="button" variant="outline" onClick={()=>setOpen(!open)}>{t('import')}</Button>
    </div>
    <Dialog.Root open={exportOpen} onOpenChange={value=>{if(!exportPending)setExportOpen(value);}}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl">
      <Dialog.Title className="text-lg font-semibold">{tx('current')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{tx('exportHelp')}</Dialog.Description>
      <form onSubmit={download} className="mt-4 space-y-4">
        <fieldset disabled={exportPending} className="space-y-2"><legend className="mb-2 text-sm font-semibold">{tc('companies')}</legend>{companies.map(c=><label key={c.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="company" value={c.id} defaultChecked={selectedCompanyIds.includes(c.id)}/>{c.name}</label>)}</fieldset>
        <fieldset disabled={exportPending}><legend className="mb-2 text-sm font-semibold">{tc('categories')}</legend><div className="grid gap-2 sm:grid-cols-2">{LABEL_IMPORT_DEFINITIONS.map(d=><label key={d.kind} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="kind" value={d.kind} defaultChecked/>{category(d.kind)}</label>)}</div></fieldset>
        <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="inactive" value="1" disabled={exportPending}/>{tx('inactive')}</label><ErrorBanner message={exportError}/>
        <div className="flex justify-end gap-2"><Dialog.Close asChild><Button type="button" variant="secondary" disabled={exportPending}>{tc('cancel')}</Button></Dialog.Close><Button type="submit" disabled={exportPending||!companies.length}>{exportPending?t('working'):tx('download')}</Button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    {open&&<form method="post" action="/admin/settings/system-labels/errors" encType="multipart/form-data" className="space-y-4 rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>{mode==='merge'&&<p className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{tx('blankHelp')}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm"><span className="block">{t('file')}</span><input ref={fileInput} name="file" aria-label={t('file')} type="file" accept=".xlsx" disabled={pending} className={inputCls} onChange={e=>{reset();setFile(e.target.files?.[0]??null);}}/></label>
        <label className="space-y-1 text-sm"><span className="block">{t('mode')}</span><select name="mode" className={inputCls} value={mode} disabled={pending} onChange={e=>{reset();setMode(e.target.value as LabelImportMode);}}><option value="add">{t('add')}</option><option value="update">{t('update')}</option><option value="merge">{tx('merge')}</option></select></label>
        <Button type="button" disabled={!file||pending} onClick={analyse}>{pending?t('working'):t('preview')}</Button>
      </div>
      <ErrorBanner message={error}/>
      {summary&&<p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{t('summary',summary)}</p>}
      {preview&&<>
        <div className={`${tableWrapCls} max-h-96 overflow-auto`}><table className="w-full text-sm"><thead className={theadCls}><tr><th className={thCls}>{tx('include')}</th>{['row','result','current','proposed','message'].map(k=><th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
          <tbody className={tbodyCls}>{preview.rows.map((r,i)=><tr key={i} className={r.outcome==='error'?'bg-destructive/5':''}>
            <td className="px-3 py-2 align-top"><input type="checkbox" aria-label={`${tx('include')} ${r.sheet} ${r.row}`} disabled={pending||r.outcome==='skip'} checked={selectedKeys?.includes(r.sheet+':'+r.row)??false} onChange={e=>selectRow(r.sheet+':'+r.row,e.target.checked)}/></td><td className="px-3 py-2 align-top">{r.sheet} · {r.row}</td><td className="px-3 py-2 align-top">{r.outcome==='skip'?tx('noChange'):r.outcome==='add'?tx('new'):t(`outcome.${r.outcome}`)}</td>
            {[r.before,r.after].map((v,n)=><td key={n} className="max-w-80 px-3 py-2 align-top"><dl>{v?Object.entries(v).map(([k,value])=><div key={k}><dt className="inline text-xs text-muted-foreground">{k}: </dt><dd className="inline break-words">{value||'—'}</dd></div>):'—'}</dl></td>)}
            <td className="px-3 py-2 align-top">{r.message}</td></tr>)}</tbody></table></div>
        {previewDirty&&<p className="text-sm text-amber-700 dark:text-amber-300">{tx('previewAgain')}</p>}
        {!preview.valid&&<p className="text-sm text-destructive">{t('fixErrors')}</p>}
        {preview.rows.some(r=>r.outcome==='error')&&<Button type="submit" variant="outline" disabled={pending}>{t('errors')}</Button>}
        {updates&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e=>setConfirmed(e.target.checked)}/>{t('confirmUpdates')}</label>}
        <Button type="button" disabled={pending||previewDirty||!preview.valid||updates&&!confirmed} onClick={apply}>{t('confirm')}</Button>
      </>}
    </form>}
  </section>;
}
